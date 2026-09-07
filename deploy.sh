#!/bin/bash
# =====================================================================
#  NodeShop 管理工具  （命令: shop）
#  --------------------------------------------------------------------
#  - 首次运行（curl 管道或尚未安装时）：自动 准备环境→拉代码→生成 .env→
#    构建→迁移→建默认管理员，全程用默认值，不打断输入。
#  - 之后用 `shop` 调出管理菜单：查看信息 / 更新 / 回滚 / 重置登录 /
#    添加域名反代 / 查看日志 / 退出。所有操作保留数据库与 .env。
#  - 默认管理员: admin@nodeshop.com / admin123456（可通过菜单 4 修改）
# =====================================================================
set -euo pipefail

SOFTWARE_VERSION="1.0.0"   # 整体版本：与 backend/frontend/admin 的 package.json 对齐
REPO_URL="https://github.com/wstimin/syjdmb.git"
INSTALL_DIR="${INSTALL_DIR:-/opt/nodeshop}"
MANAGE="$INSTALL_DIR/deploy.sh"

# 默认管理员（首次安装用；已存在则保留不覆盖）
DEFAULT_ADMIN_EMAIL="admin@nodeshop.com"
DEFAULT_ADMIN_PASS="admin123456"

# GitHub Actions 预编译镜像包（滚动标签 nightly，openssl 明文无需凭证；可用 PREBUILT_URL 覆盖）
PREBUILT_URL="${PREBUILT_URL:-https://github.com/wstimin/syjdmb/releases/download/nightly/nodeshop-images.tar.gz}"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info(){ echo -e "${CYAN}[INFO]${NC} $*"; }
ok(){   echo -e "${GREEN}[ OK ]${NC} $*"; }
warn(){ echo -e "${YELLOW}[WARN]${NC} $*"; }
err(){  echo -e "${RED}[ERR!]${NC} $*"; }

# =====================================================================
# 环境准备：Docker 安装
# =====================================================================
install_docker_if_needed() {
  if command -v docker &>/dev/null && docker compose version &>/dev/null; then
    ok "Docker 已就绪"
  else
    info "安装 Docker..."
    if [ -f /etc/os-release ]; then . /etc/os-release; OS=$ID; else OS="ubuntu"; fi
    if [ "$OS" = "centos" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
      yum install -y yum-utils >/dev/null 2>&1 && yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo >/dev/null 2>&1 || true
      yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1 || true
    else
      command -v git >/dev/null 2>&1 || apt-get install -y -qq git >/dev/null 2>&1 || true
      curl -fsSL https://get.docker.com | sh || true
    fi
    systemctl enable docker >/dev/null 2>&1 && systemctl start docker >/dev/null 2>&1 || true
    command -v git >/dev/null 2>&1 || apt-get install -y -qq git >/dev/null 2>&1 || yum install -y git >/dev/null 2>&1 || true
    ok "Docker 安装完成"
  fi
  # Docker 镜像加速（国内服务器）
  if ! grep -q "registry-mirrors" /etc/docker/daemon.json 2>/dev/null; then
    info "配置 Docker 镜像加速..."
    mkdir -p /etc/docker
    cat > /etc/docker/daemon.json <<'DAEMON'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://hub-mirror.c.163.com",
    "https://mirror.ccs.tencentyun.com"
  ]
}
DAEMON
    systemctl daemon-reload >/dev/null 2>&1 && systemctl restart docker >/dev/null 2>&1 || true
    ok "镜像加速已配置"
  fi
}

# =====================================================================
# .env：保留优先（更新不丢配置），仅首次生成
# =====================================================================
ensure_env() {
  if [ -f "$INSTALL_DIR/.env" ]; then
    ok ".env 已存在，保留现有配置（数据库密码/密钥不变）"
    return
  fi
  info "生成 .env..."
  local DB_PASS JWT_SEC SERVER_IP
  DB_PASS=$(openssl rand -base64 18 | tr -dc 'a-zA-Z0-9' | head -c 24)
  JWT_SEC=$(openssl rand -base64 36 | tr -dc 'a-zA-Z0-9' | head -c 48)
  SERVER_IP=$(hostname -I | awk '{print $1}')
  cat > "$INSTALL_DIR/.env" <<EOF
DB_PASS=${DB_PASS}
DATABASE_URL="postgresql://nodeadmin:${DB_PASS}@postgres:5432/nodeshop?schema=public"
REDIS_URL="redis://redis:6379"
BACKEND_PORT=3001
JWT_SECRET="${JWT_SEC}"
JWT_EXPIRES_IN="15m"
JWT_REFRESH_EXPIRES_IN="7d"
FRONTEND_URL="http://${SERVER_IP}:3000"
ADMIN_URL="http://${SERVER_IP}:3002"
APP_URL="http://${SERVER_IP}:3001"
APP_NAME="NodeShop"
XUI_PANELS="[]"
EOF
  ok ".env 已生成"
}

# =====================================================================
# 拉取 GitHub Actions 预编译镜像包并 docker load（跳过服务器本机编译）。
# 下载或载入失败返回 1，由调用方回退到本机 --build（功能不受影响，只是慢）。
# =====================================================================
load_prebuilt_images() {
  info "拉取预编译镜像包（GitHub Releases: nightly）..."
  local tmp
  tmp=$(mktemp)
  if ! curl -fsSL --connect-timeout 20 --max-time 1200 -o "$tmp" "$PREBUILT_URL"; then
    warn "预编译包下载失败（${PREBUILT_URL}）→ 将使用服务器本机编译"
    rm -f "$tmp"
    return 1
  fi
  info "开始载入镜像（docker load）..."
  if docker load -i "$tmp"; then
    rm -f "$tmp"
    ok "预编译镜像已载入，本次更新不再本机编译"
    return 0
  fi
  rm -f "$tmp"
  warn "镜像载入失败 → 将使用服务器本机编译"
  return 1
}

# =====================================================================
# 部署核心：拉取预编译镜像（失败回退编译）→ 启动 → 迁移 → 默认管理员
# =====================================================================
deploy_core() {
  # 停止旧容器但保留数据卷（更新不丢数据库/Redis）
  docker compose down 2>/dev/null || true

  info "构建并启动服务（优先预编译镜像，失败才本机编译）..."
  if ! load_prebuilt_images; then
    warn "回退：本机编译并启动（约 5-10 分钟）..."
    docker compose up -d --build
  elif ! docker compose up -d 2>/dev/null; then
    warn "compose 启动失败，回退本机编译..."
    docker compose up -d --build
  fi

  info "等待数据库就绪..."
  local i okdb=0
  for i in $(seq 1 60); do
    if docker exec nodeshop-db pg_isready -U nodeadmin -d nodeshop &>/dev/null; then okdb=1; break; fi
    [ "$i" -eq 60 ] && { err "数据库启动超时"; return 1; }
    sleep 2
  done
  [ "$okdb" = "1" ] && ok "数据库就绪"

  info "等待后端容器就绪..."
  local okbe=0
  for i in $(seq 1 90); do
    local STATE
    STATE=$(docker inspect -f '{{.State.Status}}' nodeshop-backend 2>/dev/null || echo "")
    if [ "$STATE" = "running" ]; then okbe=1; break; fi
    [ "$i" -eq 90 ] && {
      warn "后端容器未就绪，最近日志："; docker logs nodeshop-backend 2>&1 | tail -20; return 1; }
    sleep 3
  done
  [ "$okbe" = "1" ] && ok "后端容器已就绪"

  # 后端镜像特征校验：若更新恰好跑在 CI 尚未产出最新镜像时，docker load 会拉到
  # 旧 nightly →「代码(工作树)最新、镜像(运行)旧」错配，节点创建修复不生效。
  # 以编译产物里的新代码特征串为准，缺失即在本机重新编译修正。
  if docker exec nodeshop-backend sh -c 'grep -q "Xray reload failed" /app/dist/inbound/inbound.service.js' 2>/dev/null; then
    ok "后端镜像为最新构建（含节点创建重载修复）"
  else
    warn "后端容器缺少最新修复特征（节点创建未重载 Xray）→ 本机编译修正..."
    docker compose up -d --build
    for i in $(seq 1 90); do
      local STATE2
      STATE2=$(docker inspect -f '{{.State.Status}}' nodeshop-backend 2>/dev/null || echo "")
      if [ "$STATE2" = "running" ]; then break; fi
      sleep 3
    done
    ok "镜像已本机编译，后端容器重启完成"
  fi

  info "执行数据库迁移（保留数据，仅应用缺失的迁移）..."
  docker exec nodeshop-backend npx prisma migrate deploy || {
    warn "迁移异常，日志："; docker logs nodeshop-backend 2>&1 | tail -20; return 1; }
  ok "数据库迁移完成"

  # 默认管理员/系统设置（upsert 幂等：已存在则不覆盖）
  info "同步系统设置与默认管理员（${DEFAULT_ADMIN_EMAIL}，已存在则不修改）..."
  docker exec -e SEED_ADMIN_EMAIL="$DEFAULT_ADMIN_EMAIL" \
    -e SEED_ADMIN_PASSWORD="$DEFAULT_ADMIN_PASS" \
    nodeshop-backend node prisma/seed.cjs 2>/dev/null || warn "seed 提示（仅同步系统设置，不影响已有数据）"
  ok "部署完成"
}

# =====================================================================
# 自定位：确保运行磁盘上的管理脚本，并安装 `shop` 命令
# =====================================================================
bootstrap_if_needed() {
  local running
  running="$(realpath "$0" 2>/dev/null || echo "$0")"
  if [ ! -f "$MANAGE" ] || [ "$running" != "$(realpath "$MANAGE" 2>/dev/null)" ]; then
    [ "$(id -u)" -ne 0 ] && { err "请使用 root 运行"; exit 1; }
    echo -e "${CYAN}══════════════════════════════════════════${NC}"
    echo -e "${CYAN}        NodeShop 一键部署                  ${NC}"
    echo -e "${CYAN}══════════════════════════════════════════${NC}"
    install_docker_if_needed
    if [ -d "$INSTALL_DIR/.git" ]; then
      info "更新代码..."
      ( cd "$INSTALL_DIR" && git pull --ff-only origin master ) 2>/dev/null || true
    else
      info "克隆项目..."
      rm -rf "$INSTALL_DIR"
      git clone "$REPO_URL" "$INSTALL_DIR" 2>/dev/null || { err "克隆失败，请检查网络"; exit 1; }
    fi
    ln -sf "$MANAGE" /usr/local/bin/shop
    chmod +x "$MANAGE"
    ok "已安装 shop 命令（管理菜单）"
    cd "$INSTALL_DIR"
    exec bash "$MANAGE"
  fi
}

# =====================================================================
# 菜单各项
# =====================================================================

# 1) 查看当前信息
cmd_status() {
  echo; echo -e "${CYAN}-------- 当前信息 --------${NC}"
  echo "  安装目录 : $INSTALL_DIR"
  echo "  软件版本 : ${SOFTWARE_VERSION}"
  echo "  当前版本 : $(cd "$INSTALL_DIR" && git rev-parse --short HEAD 2>/dev/null || echo 未知)（$(cd "$INSTALL_DIR" && git log -1 --format=%cd --date=short 2>/dev/null || echo '')）"
  local ip; ip=$(hostname -I | awk '{print $1}')
  echo "  服务器IP : $ip"
  if [ -f "$INSTALL_DIR/domain.txt" ]; then
    local d; d=$(cat "$INSTALL_DIR/domain.txt")
    echo "  域名     : $d（已配置反代）"
    echo "  前端     : https://$d"
    echo "  管理后台 : https://admin.$d"
    echo "  API      : https://api.$d"
  else
    echo "  前端     : http://${ip}:3000"
    echo "  管理后台 : http://${ip}:3002"
    echo "  API      : http://${ip}:3001/api"
  fi
  echo "  管理员   : ${DEFAULT_ADMIN_EMAIL}（密码可用菜单 4 重置）"
  echo "  数据卷   : $(docker volume inspect nodeshop_postgres_data >/dev/null 2>&1 && echo '存在（数据已保留）' || echo '未创建')"
  echo
  echo "  容器状态:"
  docker compose ps
  echo
  read -rp "  按回车返回菜单..." _
}

# 2) 更新
cmd_update() {
  echo; echo -e "${CYAN}-------- 更新 --------${NC}"
  warn "将拉取最新代码与预编译镜像包并部署。数据库、数据卷与配置保留；镜像在云端已编译好，本机不再编译（快）。"
  read -rp "  确认更新？(y/N) " a
  [ "$a" = "y" ] || [ "$a" = "Y" ] || { info "已取消"; return; }

  info "拉取最新代码..."
  # 1) 回滚（菜单3）会把 HEAD 游离到旧提交，此时 git pull 会失败 → 自动切回 master
  local cur
  cur=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)
  if [ "$cur" != "master" ]; then
    warn "当前不在 master 分支（${cur}，可能之前回滚过），自动切回..."
    git checkout master 2>/dev/null || git checkout -f -B master origin/master
  fi
  # 2) 工作区若有本地改动（如手工改过 deploy.sh）会阻塞 --ff-only：
  #    先 stash 备份再拉取；改动一直留在 stash 里，可随时 git stash list / git stash pop 找回
  if ! git diff --quiet 2>/dev/null; then
    warn "检测到本地改动（git diff 非空），先暂存再拉取..."
    git stash push -m "shop-update-before-$(date +%F_%T)" 2>/dev/null \
      || { warn "git stash 失败，本次更新取消。可先：cd /opt/nodeshop && git status 查看后手动处理"; return; }
  fi
  if ! git pull --ff-only origin master; then
    warn "git pull 失败，恢复本地改动（git stash pop）..."
    git stash pop 2>/dev/null || true
    warn "可先：cd /opt/nodeshop && git status 查看，或使用菜单 3 回滚后再试"
    return
  fi
  # 新代码里的 deploy_core/load_prebuilt_images 是本文件新实现的：
  # 直接 exec 新脚本的 __deploy 分支，让本次更新立即用上预编译镜像逻辑（不再多编译一次）
  info "已拉取新代码，切换到新部署脚本执行..."
  exec bash "$MANAGE" __deploy
}

# 3) 旧版本 / 回滚
cmd_rollback() {
  echo; echo -e "${CYAN}-------- 历史版本（最近 15 条提交）--------${NC}"
  git log --oneline -15
  echo
  read -rp "  输入要回滚到的提交号（前几位即可，回车取消）: " rev
  [ -z "$rev" ] && { info "已取消"; return; }
  if ! git cat-file -e "$rev^{commit}" 2>/dev/null; then warn "无效的提交号：$rev"; return; fi
  info "回滚到 $rev 并重新部署（master 会指向该提交，后续更新正常，不再游离 HEAD）..."
  git checkout -B master "$rev"
  deploy_core || { warn "回滚部署失败，代码已切换。"; return; }
  warn "已回滚到 $rev。回到最新版请使用菜单 2「更新」。"
}

# 4) 重置登录信息
cmd_reset_login() {
  echo; echo -e "${CYAN}-------- 重置登录信息 --------${NC}"
  local cur
  cur=$(docker exec -i -w /app nodeshop-backend node -e "const{P}=require('@prisma/client');const p=new P();p.user.findFirst({where:{role:{in:['SUPER_ADMIN','ADMIN']}}}).then(u=>{console.log(u?u.email:'');return p.\$disconnect()})" 2>/dev/null || echo "")
  echo "  当前管理员邮箱 : ${cur:-未知}"
  read -rp "  新邮箱（回车保持不变: ${cur:-admin@nodeshop.com}）: " email
  email="${email:-$cur}"
  read -rp "  新密码（留空则保持当前密码）: " pass
  [ -z "$email" ] && { warn "邮箱不能为空"; return; }
  info "正在更新管理员登录信息..."
  if docker exec -i -w /app -e EMAIL="$email" -e PASS="$pass" nodeshop-backend node - <<'JS'
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
(async () => {
  const p = new PrismaClient();
  const email = (process.env.EMAIL || '').trim();
  const pass = (process.env.PASS || '').trim();
  const admin = await p.user.findFirst({ where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] } } });
  if (admin) {
    const data = {};
    if (email) data.email = email;
    if (pass) data.password = await bcrypt.hash(pass, 12);
    if (!Object.keys(data).length) { console.log('未做任何修改'); await p.$disconnect(); return; }
    await p.user.update({ where: { id: admin.id }, data });
    console.log('管理员邮箱:', data.email || admin.email, '｜密码已' + (pass ? '更新' : '保持不变'));
  } else {
    const ne = email || 'admin@nodeshop.com';
    const np = pass || 'admin123456';
    await p.user.create({ data: { email: ne, password: await bcrypt.hash(np, 12), username: 'admin', role: 'SUPER_ADMIN', referralCode: 'ADMIN001' } });
    console.log('已创建管理员:', ne);
  }
  await p.$disconnect();
})().catch(e => { console.error('更新失败:', e.message); process.exit(1); });
JS
  then ok "登录信息已更新"; else err "更新失败"; fi
}

# 5) 添加域名 / 反向代理
cmd_domain() {
  echo; echo -e "${CYAN}-------- 添加域名 / 反向代理 --------${NC}"
  echo "  将创建三个子域，请先在 DNS 解析到本机公网 IP："
  echo "    https://<域名>          → 前端 (3000)"
  echo "    https://admin.<域名>    → 管理后台 (3002)"
  echo "    https://api.<域名>      → 后端 API (3001)"
  read -rp "  请输入主域名（如 shop.example.com，回车取消）: " domain
  [ -z "$domain" ] && { info "已取消"; return; }

  mkdir -p "$INSTALL_DIR/proxy"
  cat > "$INSTALL_DIR/proxy/Caddyfile" <<EOF
$domain {
    reverse_proxy frontend:3000
}
admin.$domain {
    reverse_proxy admin:3002
}
api.$domain {
    reverse_proxy backend:3001
}
EOF
  cat > "$INSTALL_DIR/proxy/docker-compose.proxy.yml" <<EOF
name: nodeshop-proxy

services:
  caddy:
    image: caddy:2-alpine
    container_name: nodeshop-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - $INSTALL_DIR/proxy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - nodeshop

networks:
  nodeshop:
    external:
      name: nodeshop_nodeshop

volumes:
  caddy_data:
  caddy_config:
EOF

  # 确保主网络存在（后端等容器可被反代访问）
  docker network inspect nodeshop_nodeshop >/dev/null 2>&1 || \
    { warn "主网络未就绪，请先完成首次部署（菜单 2 更新）后再配置反代"; return; }

  echo "$domain" > "$INSTALL_DIR/domain.txt"
  info "启动反向代理 (Caddy) 并自动申请证书..."
  ( cd "$INSTALL_DIR/proxy" && docker compose -f docker-compose.proxy.yml up -d ) || { warn "反代启动失败"; return; }
  ok "反向代理已启动"
  warn "请确认 DNS A 记录已指向本机，等待证书签发后访问 https://$domain"
  warn "如域名未解析，Caddy 会自动用自签证书，正式可用前请先完成 DNS。"
}

# 6) 查看日志
cmd_logs() {
  echo; echo "  服务: 1) backend  2) frontend  3) admin  4) caddy(如有)  0) 取消"
  read -rp "  选择服务: " s
  case "$s" in
    1) docker compose logs -f --tail=100 backend ;;
    2) docker compose logs -f --tail=100 frontend ;;
    3) docker compose logs -f --tail=100 admin ;;
    4) if [ -f "$INSTALL_DIR/proxy/docker-compose.proxy.yml" ]; then
         ( cd "$INSTALL_DIR/proxy" && docker compose -f docker-compose.proxy.yml logs -f --tail=100 caddy )
       else warn "未配置反向代理"; fi ;;
    0|*) info "取消" ;;
  esac
}

# =====================================================================
# 主菜单
# =====================================================================
main_menu() {
  while true; do
    echo
    echo -e "${CYAN}════════════════════════════════════════════${NC}"
    echo -e "${CYAN}          NodeShop 管理菜单 (shop)            ${NC}"
    echo -e "${CYAN}════════════════════════════════════════════${NC}"
    echo "   1) 查看当前信息"
    echo "   2) 更新（部署最新版，保留数据与配置）"
    echo "   3) 旧版本 / 回滚"
    echo "   4) 重置登录信息"
    echo "   5) 添加域名 / 反向代理"
    echo "   6) 查看日志"
    echo "   7) 退出"
    printf "   请输入数字后回车: "
    read -r choice
    case "$choice" in
      1) cmd_status ;;
      2) cmd_update ;;
      3) cmd_rollback ;;
      4) cmd_reset_login ;;
      5) cmd_domain ;;
      6) cmd_logs ;;
      7) echo "再见"; exit 0 ;;
      *) warn "无效选择，请输入 1-7" ;;
    esac
  done
}

# =====================================================================
# 入口
# =====================================================================
bootstrap_if_needed      # 首次/外部运行：装环境、落盘、装 shop、切到磁盘版

# 执行到这里说明已在磁盘版运行
cd "$INSTALL_DIR"
# 忽略文件执行位差异（安装时会 chmod +x，git 会把 0644→0755 误判为“本地改动”导致 pull 被拒；关掉此项一劳永逸）
git config core.filemode false 2>/dev/null || true
ensure_env               # 首次生成 .env；已有则保留

# `shop __deploy`：由 cmd_update 在 git pull 后 exec 进来，用新脚本逻辑直接部署
if [ "${1:-}" = "__deploy" ]; then
  deploy_core || { err "部署失败，请检查上方日志"; exit 1; }
  ok "更新完成，数据库与配置已保留"
  exit 0
fi

# 首次部署检测：后端容器尚不存在 → 自动安装
if ! docker inspect nodeshop-backend >/dev/null 2>&1; then
  info "检测到首次部署，正在安装并启动（默认管理员 ${DEFAULT_ADMIN_EMAIL}）..."
  deploy_core || { err "首次部署失败，请检查上方日志"; exit 1; }
  ok "安装完成！以后在任意位置输入 shop 即可调出管理菜单"
else
  ok "已检测到已有部署，进入管理菜单"
fi

main_menu

#!/bin/bash
# =====================================================================
#  NodeShop 管理工具  （命令: shop）
#  --------------------------------------------------------------------
#  面向跨境业务与 AI 用户（ChatGPT/Claude/Gemini 直连）的国际网络连接
#  服务售买平台：前端用户端 + NestJS 后端 + 管理后台，对接 3-XUI 面板
#  自动创建节点。
#  - 首次运行（curl 管道或尚未安装时）：自动 装 Docker→拉代码→生成 .env→
#    设置管理员账号（默认值，回车即可）→构建→启动→迁移（管理员已建则保留）。
#  - 默认管理员: admin@nodeshop.com / admin123456（仅在全新数据库创建，
#    用户表非空不创建/不改口令；重置请用菜单 4）。
#  - 域名反代只填一个主域名，自动生成 前端 + 管理后台 两个对外地址；
#    API 为内置服务不对外（文档经 https://<域名>/docs 查看）。
#  - 之后用 `shop` 调出管理菜单：查看信息 / 更新 / 回滚 / 重置登录 /
#    域名管理（添加/更换/删除）/ 查看日志 / 退出。所有操作保留数据库与 .env。
# =====================================================================
set -euo pipefail

SOFTWARE_VERSION="1.1.0"   # 整体版本：与 backend/frontend/admin 的 package.json 对齐
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

# 是否为私网/保留地址（对外不可达，严禁写入对外地址）：回环、链路本地、CGNAT、
# 10/8、172.16-31/12、192.168/16 —— 这类地址写进 FRONTEND_URL 会让支付回调/邮件链接全部失效
is_private_ip() {
  local a b c
  IFS=. read -r a b c _ <<<"$1" 2>/dev/null || return 0
  case "$a" in
    10|127|169|172|192|100) ;;
    *) return 1 ;;
  esac
  [ "$a" = "10" ] && return 0
  [ "$a" = "127" ] && return 0
  [ "$a" = "169" ] && [ "$b" = "254" ] && return 0
  # 10#$b 强制十进制：$b 可能是 08/09 之类的八进制写法，[ -ge ] 按八进制解析会报错/误判
  [ "$a" = "172" ] && [ $((10#$b)) -ge 16 ] 2>/dev/null && [ $((10#$b)) -le 31 ] 2>/dev/null && return 0
  [ "$a" = "192" ] && [ "$b" = "168" ] && return 0
  [ "$a" = "100" ] && [ $((10#$b)) -ge 64 ] 2>/dev/null && [ $((10#$b)) -le 127 ] 2>/dev/null && return 0
  return 1
}

# 获取公网 IP：优先向公网回显服务查询（拒绝私网/保留地址），全部失败时退回本机网卡地址
# （逐个扫描取第一个非私网 IPv4，兼容 IPv6 在前、多网卡的情况）。
detect_public_ip() {
  local ip=""
  if command -v curl &>/dev/null; then
    local host
    for host in https://ip.sb https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
      ip=$(curl -fsSL --connect-timeout 4 --max-time 6 "$host" 2>/dev/null | head -1 | tr -d '\r\n ' || true)
      case "$ip" in
        [0-9]*.[0-9]*.[0-9]*.[0-9]*) ;;
        *) ip=""; continue ;;
      esac
      is_private_ip "$ip" && { ip=""; continue; }
      break
    done
  fi
  # 回退：本机网卡地址。hostname -I 可能输出多个地址（如 IPv6 在前）——取第一个非私网 IPv4
  if [ -z "$ip" ]; then
    local addr
    for addr in $(hostname -I 2>/dev/null || true); do
      case "$addr" in
        [0-9]*.[0-9]*.[0-9]*.[0-9]*) ;;
        *) continue ;;
      esac
      is_private_ip "$addr" && continue
      ip="$addr"; break
    done
  fi
  echo "$ip"
}

# 从 .env 的 FRONTEND_URL/ADMIN_URL 提取服务器 IP（安装摘要/状态显示优先用配置值，
# 避免每次重新探测 24s 挂起）。用两条宽松 grep 只取第一个 IPv4：域名形态
# （https://shop.example.com）不含 IP → 返回空，由调用方决定是否回退探测。
read_env_ip() {
  local ip
  ip=$(grep -E '^FRONTEND_URL=' "$INSTALL_DIR/.env" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  [ -z "$ip" ] && ip=$(grep -E '^ADMIN_URL=' "$INSTALL_DIR/.env" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  echo "$ip"
}

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
      command -v curl >/dev/null 2>&1 || apt-get install -y -qq curl >/dev/null 2>&1 || true
      curl -fsSL https://get.docker.com | sh || true
    fi
    systemctl enable docker >/dev/null 2>&1 && systemctl start docker >/dev/null 2>&1 || true
    command -v git >/dev/null 2>&1 || apt-get install -y -qq git >/dev/null 2>&1 || yum install -y git >/dev/null 2>&1 || true
    # 终检兜底：上方 yum/get.docker.com 失败会被 || true 吞掉，不能假装装好了
    if ! command -v docker &>/dev/null || ! docker compose version &>/dev/null; then
      err "Docker 安装失败，请检查上方日志（常见原因：系统源不可用/网络受限）。可手动安装 Docker 后重跑本脚本。"
      exit 1
    fi
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
  SERVER_IP=$(detect_public_ip)
  # 对外地址写私网 IP（10./172.16-31./192.168./100.64-127./127./169.254.）会生成
  # FRONTEND_URL=http://<私网>:3000 —— 外部完全不可达（支付回调/邮件链接全部失效）。
  # 自动探测只认公网地址；探测失败或仅拿到私网地址时 → 让用户手动输入公网 IP，仍无效则取消安装。
  if [ -z "$SERVER_IP" ] || is_private_ip "$SERVER_IP"; then
    if [ -n "$SERVER_IP" ]; then
      warn "自动探测到的地址（${SERVER_IP}）为内网/保留地址，对外不可达。"
    else
      warn "自动探测公网 IP 失败（公网回显服务与网卡地址均不可用）。"
    fi
    read -rp "  请手动输入服务器公网 IP（如 8.8.8.8，回车取消安装）: " SERVER_IP || true
    case "$SERVER_IP" in
      [0-9]*.[0-9]*.[0-9]*.[0-9]*) ;;
      *) err "未提供有效的公网 IP，安装已取消（可修复服务器网络后重跑脚本）"; exit 1 ;;
    esac
    is_private_ip "$SERVER_IP" && { err "该地址为内网/保留地址（${SERVER_IP}），不允许写入对外地址，安装已取消"; exit 1; }
  fi
  cat > "$INSTALL_DIR/.env" <<EOF
DB_PASS=${DB_PASS}
DATABASE_URL="postgresql://nodeadmin:${DB_PASS}@postgres:5432/nodeshop?schema=public"
REDIS_URL="redis://redis:6379"
BACKEND_PORT=3001
JWT_SECRET="${JWT_SEC}"
JWT_EXPIRES_IN="15m"
JWT_REFRESH_EXPIRES_IN="7d"
# 对外地址（公网）：FRONTEND_URL/ADMIN_URL 用于邮件链接与 CORS 白名单。
# APP_URL 用于支付回调——回调必须公网可达，因此指向前端地址（走前端 /api 代理到后端），
# 不指向内置的后端端口。
FRONTEND_URL="http://${SERVER_IP}:3000"
ADMIN_URL="http://${SERVER_IP}:3002"
APP_URL="http://${SERVER_IP}:3000"
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
  # 回滚（菜单3）时代码已切到旧提交：禁用预编译镜像、改为本机编译旧代码，
  # 否则会拉到最新的 nightly 镜像，导致「回滚」实际在跑最新版、等于没回滚。
  if [ "${SKIP_PREBUILT:-0}" = "1" ]; then
    warn "已跳过预编译镜像（回滚/本地编译模式）"
    return 1
  fi
  info "拉取预编译镜像包（GitHub Releases: nightly）..."
  local tmp
  tmp="$INSTALL_DIR/.prebuilt-$$.tgz"   # 下载到磁盘而非 /tmp(tmpfs)：小内存 VPS 的 /tmp 可能放不下镜像包
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
  # 本机编译时把当前提交作为 GIT_HASH 传给 compose build（与 CI 镜像标注同构），
  # 使「代码/镜像一致性校验」在本地编译后也能通过，避免重复重编译
  export GIT_HASH="${GIT_HASH:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"

  # 停止旧容器但保留数据卷（更新不丢数据库/Redis）
  docker compose down 2>/dev/null || true

  info "构建并启动服务（优先预编译镜像，失败才本机编译）..."
  if ! load_prebuilt_images; then
    warn "回退：本机编译并启动（约 5-10 分钟）..."
    if ! docker compose up -d --build 2>&1; then
      err "构建/启动失败："; docker compose ps; docker compose logs --tail=30 backend frontend admin 2>/dev/null
      return 1
    fi
  elif ! docker compose up -d 2>/dev/null; then
    warn "compose 启动失败，回退本机编译..."
    if ! docker compose up -d --build 2>&1; then
      err "构建/启动失败："; docker compose ps; docker compose logs --tail=30 backend frontend admin 2>/dev/null
      return 1
    fi
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

  # 代码/镜像一致性校验：确保「git 拉到的代码」与「运行的镜像」来自同一提交。
  # CI 构建时在镜像内写入 /app/.git-hash（build.yml → GIT_HASH=${{ github.sha }}）；
  # 本机编译经 compose build args 传入 GIT_HASH。镜像标注缺失（旧 CI 产物）或
  # 与当前工作树提交不一致（CI 尚未产出最新包）→ 本机重编译兜底，保证更新即最新。
  # build_ok：是否为「代码与镜像一致」的干净构建。本机编译修正失败（fail-open 分支）时置 0，
  # 后续迁移/seed 一并跳过 —— 否则新迁移会作用到正在运行的旧镜像对应数据库（可能破坏旧版服务）。
  local build_ok=1
  if command -v git >/dev/null 2>&1; then
    local EXPECT_HASH IMG_HASH
    EXPECT_HASH=$(git rev-parse HEAD 2>/dev/null || echo "")
    IMG_HASH=$(docker exec nodeshop-backend cat /app/.git-hash 2>/dev/null || echo "")
    if [ -n "$EXPECT_HASH" ] && [ "$IMG_HASH" = "$EXPECT_HASH" ]; then
      ok "镜像与代码一致（提交 ${EXPECT_HASH}）"
    else
      warn "镜像与代码不一致（期望提交 ${EXPECT_HASH}，镜像标注 ${IMG_HASH:-无}）→ 本机编译修正..."
      if ! docker compose up -d --build 2>&1; then
        # fail-open：编译失败不中断部署 —— 当前已载入的镜像继续运行，服务不中断
        # （代码与镜像暂不一致，但旧版本仍可用；等资源/网络恢复后再次「更新」即可）。
        # 注意：不能让本函数 return 1 —— 那会把正在跑的服务/迁移流程整个拉垮。
        build_ok=0
        warn "本机编译失败，维持当前已载入镜像继续运行（服务不受影响，可稍后重新「更新」）。本批跳过迁移与 seed。日志如下："
        docker compose ps || true
        docker compose logs --tail=30 backend frontend admin 2>/dev/null || true
      else
        for i in $(seq 1 90); do
          local STATE2
          STATE2=$(docker inspect -f '{{.State.Status}}' nodeshop-backend 2>/dev/null || echo "")
          if [ "$STATE2" = "running" ]; then break; fi
          sleep 3
        done
        ok "本机编译完成，后端容器重启"
      fi
    fi
  fi

  if [ "$build_ok" = "1" ]; then
    info "执行数据库迁移（保留数据，仅应用缺失的迁移）..."
    # 后端容器 migrate 失败时会进入 crash-loop（restarting）状态，此时 docker exec 报
    # "is restarting"、无法执行。迁移/修复命令统一走「一次性容器」（镜像本机已加载、
    # 沿用 compose 网络与 .env，与正式容器同源同网，但不依赖它存活）；网络缺失时
    # 退回 docker exec 维持原行为。
    BK_NET=$(docker network ls --format '{{.Name}}' | grep -m1 nodeshop || true)
    run_backend_migrate() {
      if [ -n "$BK_NET" ]; then
        docker run --rm --network "$BK_NET" --env-file .env -w /app nodeshop-backend:latest "$@"
      else
        docker exec nodeshop-backend "$@"
      fi
    }
    # 历史故障自动恢复（仅针对已知迁移 20260910000001）：该迁移曾以 enum→text 索引表达式
    # 部署失败（42P17），整体回滚、数据无残留；防重索引已由 0002 以 NULLS NOT DISTINCT
    # 重建。若 _prisma_migrations 残留其「失败」记录（finished_at 为空），deploy 会被
    # P3009 永久卡住 —— 先把它标记为已回滚。此 UPDATE 等价于 prisma migrate resolve
    # --rolled-back，且不依赖后端容器存活（直接作用于数据库容器）。
    # 双保险：仅当（本镜像确认带 0002 修复迁移）且（库中 0001 确实处于失败态）才动手；
    # 健康库/已回滚/已应用一律跳过，不影响正常历史。
    if run_backend_migrate sh -c 'test -f prisma/migrations/20260910000002_fix_renewal_dup_key/migration.sql' 2>/dev/null \
      && docker exec nodeshop-db psql -U nodeadmin -d nodeshop -tAc \
         "SELECT 1 FROM public.\"_prisma_migrations\" WHERE \"migration_name\"='20260910000001_add_renewal_dup_unique' AND \"finished_at\" IS NULL" 2>/dev/null | grep -q 1; then
      info "检测到失败迁移 20260910000001（0001 已由 0002 修复），标记为已回滚..."
      docker exec nodeshop-db psql -U nodeadmin -d nodeshop -c "UPDATE public.\"_prisma_migrations\" SET \"finished_at\"=NOW(), \"rolled_back_at\"=NOW() WHERE \"migration_name\"='20260910000001_add_renewal_dup_unique' AND \"finished_at\" IS NULL;" \
        && ok "失败迁移已标记回滚" || warn "标记失败，继续尝试 deploy"
    fi
    run_backend_migrate npx prisma migrate deploy || {
      warn "迁移异常，日志："; docker logs nodeshop-backend 2>&1 | tail -20; return 1; }
    ok "数据库迁移完成"
  fi

  # 【复核】默认管理员/系统设置 seed 移出 build_ok 门、【始终执行】：迁移在 build_ok=0
  # 时保持跳过（新迁移不应作用到旧镜像对应库），但 seed 是 upsert 幂等仅同步/补齐 ——
  # 全新库若被跳过就永远没有默认管理员，管理端无法登录；失败也仅 warn，不影响部署。
  info "同步系统设置与默认管理员（${SEED_ADMIN_EMAIL:-$DEFAULT_ADMIN_EMAIL}，用户表非空则不创建/不改口令；重置请用菜单 4）..."
  docker exec -e SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-$DEFAULT_ADMIN_EMAIL}" \
    -e SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-$DEFAULT_ADMIN_PASS}" \
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

# 查询当前管理员邮箱（后端在线时从数据库读取；容器未运行/出错返回空）
get_admin_email() {
  docker exec -i -w /app nodeshop-backend node -e "const{P}=require('@prisma/client');const p=new P();p.user.findFirst({where:{role:{in:['SUPER_ADMIN','ADMIN']}}}).then(u=>{console.log(u?u.email:'');return p.\$disconnect()})" 2>/dev/null || echo ""
}

# 1) 查看当前信息
cmd_status() {
  echo; echo -e "${CYAN}-------- 当前信息 --------${NC}"
  echo "  安装目录 : $INSTALL_DIR"
  echo "  软件版本 : ${SOFTWARE_VERSION}"
  echo "  当前版本 : $(cd "$INSTALL_DIR" && git rev-parse --short HEAD 2>/dev/null || echo 未知)（$(cd "$INSTALL_DIR" && git log -1 --format=%cd --date=short 2>/dev/null || echo '')）"
  local ip; ip=$(read_env_ip)
  # 域名已配置：对外地址走域名，没必要（也不该）再回退公网 IP 探测（会挂起数秒且结果无意义）
  if [ ! -f "$INSTALL_DIR/domain.txt" ]; then
    [ -z "$ip" ] && ip=$(detect_public_ip)
  fi
  if [ -z "$ip" ]; then
    echo "  服务器IP : 未知（自动探测失败）"
  else
    echo "  服务器IP : $ip"
  fi
  if [ -f "$INSTALL_DIR/domain.txt" ]; then
    local d; d=$(cat "$INSTALL_DIR/domain.txt")
    echo "  域名     : $d（已配置反代）"
    echo "  前端     : https://$d"
    echo "  管理后台 : https://admin.$d"
    echo "  API      : 内置服务（不对外，文档见 https://$d/docs）"
  elif [ -n "$ip" ]; then
    echo "  前端     : http://${ip}:3000"
    echo "  管理后台 : http://${ip}:3002"
    echo "  API      : 内置服务（不对外，本机 127.0.0.1:3001）"
  else
    echo "  前端     : 未配置（无公网 IP 信息，请用菜单 5 配置域名或编辑 .env）"
    echo "  管理后台 : 未配置（同上）"
    echo "  API      : 内置服务（不对外，本机 127.0.0.1:3001）"
  fi
  local adm; adm=$(get_admin_email)
  echo "  管理员   : ${adm:-未知}（密码可用菜单 4 重置）"
  echo "  数据卷   : $(docker volume inspect nodeshop_postgres_data >/dev/null 2>&1 && echo '存在（数据已保留）' || echo '未创建')"
  echo
  echo "  容器状态:"
  docker compose ps || true   # set -e 保护：docker daemon 异常时不至于崩掉整个菜单
  echo
  read -rp "  按回车返回菜单..." _ || true
}

# 2) 更新
cmd_update() {
  echo; echo -e "${CYAN}-------- 更新 --------${NC}"
  warn "将拉取最新代码与预编译镜像包并部署。数据库、数据卷与配置保留；镜像在云端已编译好，本机不再编译（快）。"
  read -rp "  确认更新？(y/N) " a
  [ "$a" = "y" ] || [ "$a" = "Y" ] || { info "已取消"; return; }

  info "拉取最新代码..."
  # 1) 工作区若有本地改动（如手工改过 deploy.sh）会阻塞 checkout/pull —— 先 stash 备份。
  #    必须在切分支【之前】stash：否则下一步 git checkout -f 会静默丢弃本地改动。
  if ! git diff --quiet 2>/dev/null; then
    warn "检测到本地改动（git diff 非空），先暂存再拉取..."
    git stash push -m "shop-update-before-$(date +%F_%T)" 2>/dev/null \
      || { warn "git stash 失败，本次更新取消。可先：cd /opt/nodeshop && git status 查看后手动处理"; return; }
  fi
  # 2) 回滚（菜单3）会把 HEAD 游离到旧提交，此时 git pull 会失败 → 自动切回 master
  #    （工作区已 stash 干净，可安全重建本地 master，不会丢改动）
  local cur
  cur=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)
  if [ "$cur" != "master" ]; then
    warn "当前不在 master 分支（${cur}，可能之前回滚过），自动切回..."
    # 两条路径都可能失败（无本地 master 分支 + origin/master 解析失败）：此时若继续，
    # set -e 会把整个菜单崩掉 → 显式失败的，恢复本地改动并取消本次更新
    if ! git checkout master 2>/dev/null && ! git checkout -f -B master origin/master; then
      warn "切回 master 失败（本地与远程分支均不可用），恢复本地改动并取消本次更新"
      git stash pop 2>/dev/null || true
      return
    fi
  fi
  if ! git pull --ff-only origin master; then
    warn "git pull 失败，恢复本地改动（git stash pop）..."
    git stash pop 2>/dev/null || true
    warn "可先：cd /opt/nodeshop && git status 查看，或使用菜单 3 回滚后再试"
    return
  fi
  # 新代码里的 deploy_core/load_prebuilt_images 是本文件新实现的：
  # 直接 exec 新脚本的 __deploy 分支，让本次更新立即用上预编译镜像逻辑（不再多编译一次）。
  # exec 之前先做语法检查 —— 否则新脚本有语法错误时 exec 直接失败退出，连菜单都回不去
  if ! bash -n "$MANAGE" 2>/dev/null; then
    warn "新脚本语法检查未通过，跳过自动部署（代码已更新；可手动 bash deploy.sh 继续，或先用菜单 3 回滚）"
    return
  fi
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
  # 工作区有本地改动（如手工改过 deploy.sh）时 checkout 会被拒绝，且 set -e 会直接退出整个菜单：
  # 先把本地改动暂存（可随时 git stash pop 找回），切换失败则提示取消、留在菜单
  if ! git diff --quiet 2>/dev/null; then
    warn "检测到本地改动，先暂存再回滚（改动保留在 stash，可 git stash pop 找回）..."
    if ! git stash push -m "shop-rollback-$(date +%F_%T)" 2>/dev/null; then
      warn "本地改动暂存失败，回滚已取消。可先：cd /opt/nodeshop && git status 查看后手动处理"
      return
    fi
  fi
  if ! git checkout -B master "$rev"; then
    warn "切换到提交 $rev 失败，回滚已取消（本地改动已暂存到 stash，可用 git stash pop 找回）"
    return
  fi
  SKIP_PREBUILT=1 deploy_core || { warn "回滚部署失败，代码已切换。"; return; }
  warn "已回滚到 $rev（仅代码回滚，数据库结构不回滚；回到最新版请使用菜单 2「更新」）。"
}

# 4) 重置登录信息
cmd_reset_login() {
  echo; echo -e "${CYAN}-------- 重置登录信息 --------${NC}"
  local cur
  cur=$(get_admin_email)
  echo "  当前管理员邮箱 : ${cur:-未知}"
  read -rp "  新邮箱（回车保持不变: ${cur:-admin@nodeshop.com}）: " email || true
  email="${email:-$cur}"
  read -rsp "  新密码（留空则保持当前密码，输入不回显）: " pass || true
  echo
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

# 5) 域名管理（添加 / 更换 / 删除）
cmd_domain() {
  echo; echo -e "${CYAN}-------- 域名管理 --------${NC}"
  local d=""
  [ -f "$INSTALL_DIR/domain.txt" ] && d=$(cat "$INSTALL_DIR/domain.txt")
  if [ -n "$d" ]; then
    echo "  当前域名 : https://$d （前端） / https://admin.$d （管理后台）"
  else
    echo "  当前域名 : 未配置（直接用 http://服务器IP:3000 访问）"
  fi
  echo
  echo "  1) 添加 / 更换域名（覆盖当前配置，自动核验 DNS 并申请新证书）"
  echo "  2) 删除域名（停止反代，恢复 IP 直连）"
  echo "  0) 返回"
  read -rp "  请选择: " c
  case "$c" in
    1) cmd_domain_set ;;
    2) cmd_domain_remove ;;
    *) info "已取消" ;;
  esac
}

# DNS 预检：域名能解析才可能申请到证书；解析不到只提示、不阻断（Caddy 会持续重试）
domain_dns_check() {
  local name="$1" label="$2" ips=""
  ips=$(getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | sort -u | head -3 | tr '\n' ' ' || true)
  if [ -z "$ips" ]; then
    warn "$label $name 无法解析 —— 证书将无法签发。请先到域名商/解析平台把 $name 的 A 记录指向本机公网 IP"
  else
    info "$label $name 已解析: ${ips% }"
  fi
}

# 5.1) 添加 / 更换域名
cmd_domain_set() {
  echo; echo -e "${CYAN}-------- 添加 / 更换域名 --------${NC}"
  echo "  只需填写一个主域名，自动创建两个对外地址（互不冲突，各自独立证书）："
  echo "    https://<域名>          → 前端 (3000)"
  echo "    https://admin.<域名>    → 管理后台 (3002)"
  echo "  后端 API 为内置服务，不配置独立域名：公网请求统一经前端/管理后台的 /api 代理转发，"
  echo "  接口文档可在 https://<域名>/docs 查看。"
  echo "  请先把 <域名> 与 admin.<域名> 的 DNS A 记录解析到本机公网 IP（本脚本会帮你核验）。"
  read -rp "  请输入主域名（如 shop.example.com，回车取消）: " domain
  [ -z "$domain" ] && { info "已取消"; return; }
  # 严格校验域名：只允许字母/数字/连字符/点、必须含至少一个点；禁止协议头(https://)、通配符、
  # 路径、空格和 & | $ 等特殊字符——否则 sed 会把 .env 写成损坏地址、Caddyfile 无法加载。
  case "$domain" in
    *://*|*\**|*/*|*[!a-zA-Z0-9.-]*|.*|*.|*..*) warn "域名格式无效（应形如 shop.example.com，不要带 https://、* 等字符）"; return ;;
  esac
  case "$domain" in
    *.*) ;;
    *) warn "域名格式无效（需包含点，如 shop.example.com）"; return ;;
  esac
  case "$domain" in
    admin.*) warn "请输入主域名本身（示例 admin.example.com 请填 example.com）"; return ;;
  esac
  info "已确认主域名：$domain（将自动创建 https://$domain 与 https://admin.$domain）..."

  # DNS 预检
  domain_dns_check "$domain" "主域名"
  domain_dns_check "admin.$domain" "管理后台子域名"

  # 覆盖前提示：若 Caddyfile 曾被手工改过（非脚本生成），先确认再覆盖
  if [ -f "$INSTALL_DIR/proxy/Caddyfile" ]; then
    if ! grep -q "reverse_proxy frontend:3000" "$INSTALL_DIR/proxy/Caddyfile" \
       || ! grep -q "reverse_proxy admin:3002" "$INSTALL_DIR/proxy/Caddyfile"; then
      warn "检测到当前 Caddyfile 含手工改动（非本脚本生成），将被本次配置整体覆盖。"
      read -rp "  确认覆盖？(y/N) " a2
      [ "$a2" = "y" ] || [ "$a2" = "Y" ] || { info "已取消"; return; }
    fi
  fi

  mkdir -p "$INSTALL_DIR/proxy"
  cat > "$INSTALL_DIR/proxy/Caddyfile" <<EOF
$domain {
    # API 文档（Swagger）内置入口：不开独立 api 域名
    handle /docs* {
        reverse_proxy backend:3001
    }
    handle {
        reverse_proxy frontend:3000
    }
}
admin.$domain {
    reverse_proxy admin:3002
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
  # 显式强制重建 caddy：保证新域名与证书逻辑立即生效（仅靠 Caddy 文件监听在已运行容器上不保证重载）
  info "重启反向代理 (Caddy) 使新域名生效..."
  ( cd "$INSTALL_DIR/proxy" && docker compose -f docker-compose.proxy.yml up -d --force-recreate caddy ) \
    || { warn "反代启动失败，请用菜单 6 → 4 查看 Caddy 日志"; return; }
  ok "反向代理已重启并加载新域名"
  # 同步 .env 对外地址（密码重置邮件链接、CORS 白名单、支付回调地址），并重建 backend 使配置生效。
  # 支付回调经前端 https://域名/api/... 转发到后端，因此 APP_URL 指向前端域名。
  info "同步 .env 对外地址为 https://${domain} ..."
  sed -i -E \
    -e "s|^FRONTEND_URL=.*|FRONTEND_URL=\"https://${domain}\"|" \
    -e "s|^ADMIN_URL=.*|ADMIN_URL=\"https://admin.${domain}\"|" \
    -e "s|^APP_URL=.*|APP_URL=\"https://${domain}\"|" \
    "$INSTALL_DIR/.env" 2>/dev/null || warn ".env 更新失败（可手动修改 FRONTEND_URL/ADMIN_URL/APP_URL）"
  docker compose up -d --force-recreate --no-deps backend >/dev/null 2>&1 || warn "backend 重建失败，可稍后手动重启使其生效"
  ok "对外地址已更新"
  warn "请确认两个域名都已解析到本机，等待证书签发后访问 https://$domain 与 https://admin.$domain"
  warn "如域名未解析，Caddy 会自动用自签证书，正式可用前请先完成 DNS。"
}

# 5.2) 删除域名
cmd_domain_remove() {
  echo; echo -e "${CYAN}-------- 删除域名 --------${NC}"
  if [ ! -f "$INSTALL_DIR/domain.txt" ]; then
    info "当前未配置域名（本来就使用 IP 直连），无需删除"
    return
  fi
  local d; d=$(cat "$INSTALL_DIR/domain.txt")
  echo "  当前域名 : https://$d"
  warn "将停止并删除反向代理（Caddy），对外访问还原为 http://<服务器IP>:3000 / http://<服务器IP>:3002。"
  warn "数据、证书缓存与 .env 均保留，之后可随时用菜单 5 重新添加域名。"
  read -rp "  确认删除？(y/N) " a
  [ "$a" = "y" ] || [ "$a" = "Y" ] || { info "已取消"; return; }

  if [ -f "$INSTALL_DIR/proxy/docker-compose.proxy.yml" ]; then
    info "停止反向代理..."
    ( cd "$INSTALL_DIR/proxy" && docker compose -f docker-compose.proxy.yml down ) || warn "反向代理停止失败（可忽略）"
  fi
  rm -f "$INSTALL_DIR/domain.txt"
  ok "已删除域名配置"

  # .env 对外地址还原为 IP 形式（能探测到公网 IP 时）
  local ip=""; ip=$(detect_public_ip)
  if [ -n "$ip" ]; then
    info "同步 .env 对外地址为 http://${ip}:3000 ..."
    sed -i -E \
      -e "s|^FRONTEND_URL=.*|FRONTEND_URL=\"http://${ip}:3000\"|" \
      -e "s|^ADMIN_URL=.*|ADMIN_URL=\"http://${ip}:3002\"|" \
      -e "s|^APP_URL=.*|APP_URL=\"http://${ip}:3000\"|" \
      "$INSTALL_DIR/.env" 2>/dev/null || warn ".env 更新失败（可手动修改 FRONTEND_URL/ADMIN_URL/APP_URL）"
    docker compose up -d --force-recreate --no-deps backend >/dev/null 2>&1 || warn "backend 重建失败，可稍后手动重启使其生效"
  else
    warn "无法探测公网 IP，.env 仍指向原域名；可稍后用本机 IP 手动修改 FRONTEND_URL/ADMIN_URL/APP_URL"
  fi
  ok "域名已删除。前端：http://${ip:-<服务器IP>}:3000，管理后台：http://${ip:-<服务器IP>}:3002"
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
    echo "   5) 域名管理（添加 / 更换 / 删除）"
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

# 已部署判定：以 .env 是否存在为准（首次生成 .env 即视为已有部署框架）。
# 容器存在性不能当判据 —— 上一轮更新若 docker compose up 失败/中断，后端容器会缺失，
# 此时 `shop` 仍必须进菜单（可用菜单 2 重新部署），绝不能掉进首次安装交互流程。
ENV_EXISTED=0
[ -f "$INSTALL_DIR/.env" ] && ENV_EXISTED=1
ensure_env               # 首次生成 .env；已有则保留

# `shop __deploy`：由 cmd_update 在 git pull 后 exec 进来，用新脚本逻辑直接部署
if [ "${1:-}" = "__deploy" ]; then
  deploy_core || { err "部署失败，请检查上方日志"; exit 1; }
  ok "更新完成，数据库与配置已保留"
  exit 0
fi

if [ "$ENV_EXISTED" = "0" ]; then
  # 首次部署（.env 刚生成）：交互设置管理员 + 自动安装。
  # 已用环境变量 SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD 预设（自动化脚本）时跳过提问；直接回车用默认值。
  if [ -z "${SEED_ADMIN_EMAIL:-}" ] && [ -z "${SEED_ADMIN_PASSWORD:-}" ]; then
    echo; echo -e "${CYAN}-------- 设置管理员账号（回车使用默认值）--------${NC}"
    read -rp "  管理员邮箱 [${DEFAULT_ADMIN_EMAIL}]: " SEED_ADMIN_EMAIL || true
    read -rsp "  管理员密码 [${DEFAULT_ADMIN_PASS}]: " SEED_ADMIN_PASSWORD || true
    echo
    SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-$DEFAULT_ADMIN_EMAIL}"
    SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-$DEFAULT_ADMIN_PASS}"
  fi
  info "检测到首次部署，正在安装并启动（管理员 ${SEED_ADMIN_EMAIL}）..."
  deploy_core || { err "首次部署失败，请检查上方日志"; exit 1; }
  # 安装完成摘要（README 承诺：输出访问地址和登录凭据；地址直接读 .env，不再二次探测公网 IP）
  INSTALL_IP=$(read_env_ip)
  [ -z "$INSTALL_IP" ] && INSTALL_IP=$(detect_public_ip)
  echo; echo -e "${GREEN}════════════════ 安装完成 ════════════════${NC}"
  if [ -n "$INSTALL_IP" ]; then
    echo "  前端用户端   : http://${INSTALL_IP}:3000"
    echo "  管理后台     : http://${INSTALL_IP}:3002"
  else
    echo "  访问地址     : 见 $INSTALL_DIR/.env 中的 FRONTEND_URL / ADMIN_URL（公网 IP 探测失败）"
  fi
  echo "  API          : 内置服务（不对外暴露，配置域名后在 https://<域名>/docs 查看文档）"
  if [ -f "$INSTALL_DIR/domain.txt" ]; then
    echo "  域名前端     : https://$(cat "$INSTALL_DIR/domain.txt")"
    echo "  管理后台域名 : https://admin.$(cat "$INSTALL_DIR/domain.txt")"
  fi
  echo "  管理员       : ${SEED_ADMIN_EMAIL}（密码为你刚设置的值 / 默认 admin123456，可随时用菜单 4 重置）"
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
  ok "安装完成！以后在任意位置输入 shop 即可调出管理菜单"
else
  ok "已检测到已有部署，进入管理菜单"
  # 后端容器缺失（如上轮更新失败/中断）→ 提示用菜单 2 重新部署即可，不拦截进菜单
  if ! docker inspect nodeshop-backend >/dev/null 2>&1; then
    warn "后端容器当前未运行（可能上轮更新中断）。请使用菜单 2「更新」重新部署；其余菜单功能不受影响。"
  fi
fi

main_menu

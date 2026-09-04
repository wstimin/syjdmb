#!/bin/bash
# ============================================
# NodeShop 一键部署 — 零交互
# 用法: sudo bash deploy.sh
# ============================================
set -euo pipefail

# ============ 配置（可按需修改） ============
REPO_URL="https://github.com/wstimin/syjdmb.git"
INSTALL_DIR="/opt/nodeshop"
DEFAULT_ADMIN_EMAIL="admin@nodeshop.com"
DEFAULT_ADMIN_PASS="admin123456"
# ============================================

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info(){ echo -e "${CYAN}[INFO]${NC} $*"; }
ok(){   echo -e "${GREEN}[ OK ]${NC} $*"; }
err(){  echo -e "${RED}[ERR!]${NC} $*"; exit 1; }

[ "$(id -u)" -ne 0 ] && err "请使用 root: sudo bash deploy.sh"

# --- 1.5 交互式配置管理员 ---
echo ""
echo -e "${CYAN}══════════════════════════════════════════════${NC}"
echo -e "${CYAN}  📧 管理员账号配置${NC}"
echo -e "${CYAN}══════════════════════════════════════════════${NC}"
read -rp "  管理员邮箱 [${DEFAULT_ADMIN_EMAIL}]: " ADMIN_EMAIL
ADMIN_EMAIL="${ADMIN_EMAIL:-$DEFAULT_ADMIN_EMAIL}"
read -rp "  管理员密码 [${DEFAULT_ADMIN_PASS}]: " ADMIN_PASS
ADMIN_PASS="${ADMIN_PASS:-$DEFAULT_ADMIN_PASS}"
echo ""

# --- 1. 安装依赖 ---
info "检查环境..."
if command -v docker &>/dev/null && docker compose version &>/dev/null; then
  ok "Docker 已就绪"
else
  info "安装 Docker..."
  if [ -f /etc/os-release ]; then . /etc/os-release; OS=$ID; else OS="ubuntu"; fi
  if [ "$OS" = "centos" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
    yum install -y yum-utils && yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  else
    # 清理之前可能残留的坏 Docker 源
    rm -f /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.gpg 2>/dev/null || true
    apt-get update -qq 2>/dev/null || true
    apt-get install -y -qq ca-certificates curl git 2>/dev/null || true
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable docker && systemctl start docker
  ok "Docker 安装完成"
fi

# 配置 Docker 镜像加速（国内服务器，始终检查）
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
  systemctl daemon-reload && systemctl restart docker
  ok "镜像加速已配置"
fi

# --- 2. 克隆/更新代码 ---
if [ -d "$INSTALL_DIR/.git" ]; then
  info "更新代码..."
  cd "$INSTALL_DIR" && git pull origin master 2>/dev/null || true
else
  info "克隆项目..."
  rm -rf "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
ok "代码就绪"

# --- 3. 生成 .env ---
DB_PASS=$(openssl rand -base64 18 | tr -dc 'a-zA-Z0-9' | head -c 24)
JWT_SEC=$(openssl rand -base64 36 | tr -dc 'a-zA-Z0-9' | head -c 48)
SERVER_IP=$(hostname -I | awk '{print $1}')

cat > .env <<EOF
DB_PASS=${DB_PASS}
DATABASE_URL="postgresql://nodeadmin:${DB_PASS}@postgres:5432/nodeshop?schema=public"
REDIS_URL="redis://redis:6379"
BACKEND_PORT=3001
JWT_SECRET="${JWT_SEC}"
JWT_EXPIRES_IN="15m"
JWT_REFRESH_EXPIRES_IN="7d"
NEXT_PUBLIC_API_URL=http://backend:3001/api
FRONTEND_URL="http://${SERVER_IP}:3000"
ADMIN_URL="http://${SERVER_IP}:3002"
APP_URL="http://${SERVER_IP}:3001"
APP_NAME="NodeShop"
XUI_PANELS="[]"
EOF
ok ".env 已生成"

# --- 4. 构建启动 ---
info "构建并启动服务（首次约 5-10 分钟）..."
docker compose up -d --build --force-recreate

# 等待 PG 就绪
info "等待数据库就绪..."
for i in $(seq 1 30); do
  if docker exec nodeshop-db pg_isready -U nodeadmin -d nodeshop &>/dev/null; then
    ok "数据库就绪"
    break
  fi
  [ $i -eq 30 ] && err "数据库启动超时"
  sleep 2
  echo -ne "\r  等待中... ${i}/30"
done
echo ""

# --- 5. 迁移 + 初始化 ---
info "数据库迁移..."
docker exec nodeshop-backend npx prisma migrate deploy || true
ok "迁移完成"

info "初始化管理员..."
docker exec -e SEED_ADMIN_EMAIL="$ADMIN_EMAIL" -e SEED_ADMIN_PASSWORD="$ADMIN_PASS" \
  nodeshop-backend npx ts-node prisma/seed.ts || true
ok "初始化完成"

# --- 6. 输出结果 ---
echo ""
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo -e "${GREEN}    ✅ NodeShop 部署完成！${NC}"
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo ""
echo -e "  🌐 前端:      http://${SERVER_IP}:3000"
echo -e "  ⚙️  管理后台:  http://${SERVER_IP}:3002"
echo -e "  📡 API 文档:  http://${SERVER_IP}:3001/docs"
echo ""
echo -e "  📧 管理员:    ${ADMIN_EMAIL}"
echo -e "  🔑 密码:      ${ADMIN_PASS}"
echo ""
echo -e "  ${CYAN}常用命令:${NC}"
echo -e "    日志:  docker compose -f ${INSTALL_DIR}/docker-compose.yml logs -f backend"
echo -e "    重启:  docker compose -f ${INSTALL_DIR}/docker-compose.yml restart"
echo -e "    停止:  docker compose -f ${INSTALL_DIR}/docker-compose.yml down"
echo -e "    更新:  cd ${INSTALL_DIR} && bash deploy.sh"
echo -e "${GREEN}══════════════════════════════════════════════${NC}"

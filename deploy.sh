#!/bin/bash
# ============================================
# NodeShop 一键安装脚本
# 用法（任意目录，root 下运行）:
#   bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/syjdmb/master/deploy.sh)
# 或:
#   curl -fsSL .../deploy.sh -o install.sh && bash install.sh
# ============================================
set -euo pipefail

# ============ 默认配置 ============
REPO_URL="https://github.com/wstimin/syjdmb.git"
INSTALL_DIR="/opt/nodeshop"
# ==================================

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
info(){ echo -e "${CYAN}[INFO]${NC} $*"; }
ok(){   echo -e "${GREEN}[ OK ]${NC} $*"; }
warn(){ echo -e "${YELLOW}[WARN]${NC} $*"; }
err(){  echo -e "${RED}[ERR!]${NC} $*"; exit 1; }

[ "$(id -u)" -ne 0 ] && err "请使用 root 运行"

# ==========================================
# 步骤 1：交互式配置
# ==========================================
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       NodeShop 一键部署                  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

read -rp "  管理员邮箱 [admin@nodeshop.com]: " ADMIN_EMAIL
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@nodeshop.com}"

read -rp "  管理员密码 [admin123456]: " ADMIN_PASS
ADMIN_PASS="${ADMIN_PASS:-admin123456}"

echo ""
echo -e "  邮箱: ${GREEN}${ADMIN_EMAIL}${NC}"
echo -e "  密码: ${GREEN}${ADMIN_PASS}${NC}"
echo ""

# ==========================================
# 步骤 2：安装 Docker
# ==========================================
info "检查 Docker..."
if command -v docker &>/dev/null && docker compose version &>/dev/null; then
  ok "Docker 已就绪"
else
  info "安装 Docker..."
  if [ -f /etc/os-release ]; then . /etc/os-release; OS=$ID; else OS="ubuntu"; fi
  if [ "$OS" = "centos" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
    yum install -y yum-utils && yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  else
    rm -f /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.gpg 2>/dev/null || true
    apt-get update -qq 2>/dev/null || true
    apt-get install -y -qq ca-certificates curl git 2>/dev/null || true
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable docker && systemctl start docker
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
  systemctl daemon-reload && systemctl restart docker
  ok "镜像加速已配置"
fi

# ==========================================
# 步骤 3：拉取代码
# ==========================================
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

# ==========================================
# 步骤 4：生成 .env
# ==========================================
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
FRONTEND_URL="http://${SERVER_IP}:3000"
ADMIN_URL="http://${SERVER_IP}:3002"
APP_URL="http://${SERVER_IP}:3001"
APP_NAME="NodeShop"
XUI_PANELS="[]"
EOF
ok ".env 已生成"

# ==========================================
# 步骤 5：清理旧环境（避免密码冲突）
# ==========================================
info "清理旧容器和数据卷..."
docker compose down -v 2>/dev/null || true
ok "旧环境已清理"

# ==========================================
# 步骤 6：构建并启动
# ==========================================
info "构建并启动服务（首次约 5-10 分钟）..."
docker compose up -d --build

# ==========================================
# 步骤 7：等待 PostgreSQL 就绪
# ==========================================
info "等待数据库就绪..."
for i in $(seq 1 60); do
  if docker exec nodeshop-db pg_isready -U nodeadmin -d nodeshop &>/dev/null; then
    ok "数据库就绪"
    break
  fi
  [ $i -eq 60 ] && err "数据库启动超时"
  sleep 2
  echo -ne "\r  等待中... ${i}/60"
done
echo ""

# ==========================================
# 步骤 8：等待后端启动
# ==========================================
info "等待后端服务启动..."
for i in $(seq 1 60); do
  # 检查后端是否在监听 3001 端口
  if docker exec nodeshop-backend sh -c "wget -q -O /dev/null http://localhost:3001 2>/dev/null || true" 2>/dev/null; then
    ok "后端服务已就绪"
    break
  fi
  # 备用检查：进程是否存在
  if docker exec nodeshop-backend pgrep -f "node dist/main.js" &>/dev/null; then
    ok "后端服务已就绪"
    break
  fi
  [ $i -eq 60 ] && warn "后端可能未完全启动，继续尝试 seed..."
  sleep 3
  echo -ne "\r  等待中... ${i}/60"
done
echo ""

# ==========================================
# 步骤 9：数据库迁移
# ==========================================
info "执行数据库迁移..."
docker exec nodeshop-backend npx prisma migrate deploy 2>&1 || true
ok "迁移完成"

# ==========================================
# 步骤 10：初始化管理员
# ==========================================
info "创建管理员账号..."
SEED_OUTPUT=$(docker exec -e SEED_ADMIN_EMAIL="$ADMIN_EMAIL" -e SEED_ADMIN_PASSWORD="$ADMIN_PASS" \
  nodeshop-backend npx ts-node prisma/seed.ts 2>&1) || true
echo "$SEED_OUTPUT"
if echo "$SEED_OUTPUT" | grep -q "Admin created"; then
  ok "管理员创建成功"
else
  warn "管理员可能已存在或创建失败，尝试手动 seed..."
  docker exec nodeshop-backend npx ts-node prisma/seed.ts 2>&1 || true
fi

# ==========================================
# 步骤 11：验证服务状态
# ==========================================
echo ""
info "检查服务状态..."
docker compose ps

# ==========================================
# 完成
# ==========================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       ✅ NodeShop 部署完成！             ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  🌐 前端:      http://${SERVER_IP}:3000"
echo -e "  ⚙️  管理后台:  http://${SERVER_IP}:3002"
echo -e "  📡 API:       http://${SERVER_IP}:3001/api"
echo ""
echo -e "  📧 管理员:    ${ADMIN_EMAIL}"
echo -e "  🔑 密码:      ${ADMIN_PASS}"
echo ""
echo -e "  ${CYAN}常用命令:${NC}"
echo -e "    查看日志:  docker compose -f ${INSTALL_DIR}/docker-compose.yml logs -f"
echo -e "    重启服务:  docker compose -f ${INSTALL_DIR}/docker-compose.yml restart"
echo -e "    停止服务:  docker compose -f ${INSTALL_DIR}/docker-compose.yml down"
echo -e "    更新部署:  cd ${INSTALL_DIR} && bash deploy.sh"
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"

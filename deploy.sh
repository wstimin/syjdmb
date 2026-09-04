#!/bin/bash
# ============================================
# NodeShop 一键部署脚本
# ============================================
# 用法：
#   首次部署：  bash deploy.sh
#   更新部署：  bash deploy.sh --update
#   仅迁移DB：  bash deploy.sh --migrate
#
# 适用于：Ubuntu 20.04+ / Debian 11+ / CentOS 8+（需 root 或 sudo）

set -euo pipefail

# ============ 颜色 ============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERR!]${NC} $*"; exit 1; }

# ============ 参数解析 ============
MODE="${1:-install}"
REPO_URL="https://github.com/wstimin/syjdmb.git"
INSTALL_DIR="/opt/nodeshop"

# ============ 生成随机字符串 ============
random_string() {
  openssl rand -base64 "$1" | tr -dc 'a-zA-Z0-9' | head -c "$1"
}

# ============ 检测 root ============
check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    err "请使用 root 运行：sudo bash deploy.sh"
  fi
}

# ============ 检测操作系统 ============
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    OS_VER=$VERSION_ID
  else
    err "不支持的操作系统"
  fi
  info "检测到系统: $OS $OS_VER"
}

# ============ 安装 Docker ============
install_docker() {
  if command -v docker &>/dev/null && docker compose version &>/dev/null; then
    ok "Docker $(docker --version | awk '{print $3}' | tr -d ',') + Docker Compose 已安装"
    return
  fi

  info "安装 Docker..."
  if [ "$OS" = "centos" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
    yum install -y yum-utils
    yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  else
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/$OS/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null || true
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi

  systemctl enable docker
  systemctl start docker
  ok "Docker 安装完成"
}

# ============ 安装 Git ============
install_git() {
  if command -v git &>/dev/null; then
    ok "Git $(git --version | awk '{print $3}') 已安装"
    return
  fi
  info "安装 Git..."
  if [ "$OS" = "centos" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
    yum install -y git
  else
    apt-get install -y -qq git
  fi
  ok "Git 安装完成"
}

# ============ 交互式配置 ============
interactive_config() {
  echo ""
  echo -e "${CYAN}══════════════════════════════════════════${NC}"
  echo -e "${CYAN}     NodeShop 一键部署配置${NC}"
  echo -e "${CYAN}══════════════════════════════════════════${NC}"
  echo ""

  # 域名配置
  read -rp "请输入域名（留空则使用 IP 访问）: " DOMAIN
  DOMAIN="${DOMAIN:-}"

  # 如果有域名，配置 Nginx + SSL
  if [ -n "$DOMAIN" ]; then
    read -rp "是否配置 SSL (Let's Encrypt)？[Y/n]: " USE_SSL
    USE_SSL="${USE_SSL:-Y}"
    if [ "$USE_SSL" != "n" ] && [ "$USE_SSL" != "N" ]; then
      USE_SSL=true
    else
      USE_SSL=false
    fi
    read -rp "管理后台域名 [默认: admin.$DOMAIN]: " ADMIN_DOMAIN
    ADMIN_DOMAIN="${ADMIN_DOMAIN:-admin.$DOMAIN}"
  else
    USE_SSL=false
    ADMIN_DOMAIN=""
  fi

  # 管理员账号
  read -rp "管理员邮箱 [默认: admin@nodeshop.com]: " ADMIN_EMAIL
  ADMIN_EMAIL="${ADMIN_EMAIL:-admin@nodeshop.com}"

  read -srp "管理员密码 [默认: admin123456]: " ADMIN_PASS
  echo ""
  ADMIN_PASS="${ADMIN_PASS:-admin123456}"

  # 数据库密码
  DB_PASS=$(random_string 24)
  JWT_SECRET=$(random_string 48)

  info "自动生成数据库密码: $DB_PASS"
  info "自动生成 JWT 密钥: ${JWT_SECRET:0:12}..."
}

# ============ 克隆/更新代码 ============
clone_or_update() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "拉取最新代码..."
    cd "$INSTALL_DIR"
    git pull origin master 2>/dev/null || warn "git pull 失败，使用本地代码"
  else
    info "克隆项目..."
    rm -rf "$INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
  ok "代码就绪"
}

# ============ 生成 .env ============
generate_env() {
  local FRONTEND_URL BACKEND_PORT=3001

  if [ -n "$DOMAIN" ]; then
    FRONTEND_URL="https://$DOMAIN"
    BACKEND_URL="https://$DOMAIN"
    ADMIN_URL="https://$ADMIN_DOMAIN"
  else
    FRONTEND_URL="http://$(hostname -I | awk '{print $1}'):3000"
    BACKEND_URL="http://$(hostname -I | awk '{print $1}'):3001"
    ADMIN_URL="http://$(hostname -I | awk '{print $1}'):3002"
  fi

  cat > .env <<EOF
# ============================================
# NodeShop 环境配置（自动生成 $(date '+%Y-%m-%d %H:%M')）
# ============================================

# ---- Database ----
DATABASE_URL="postgresql://nodeadmin:${DB_PASS}@postgres:5432/nodeshop?schema=public"

# ---- Redis ----
REDIS_URL="redis://redis:6379"

# ---- Backend ----
BACKEND_PORT=3001
JWT_SECRET="${JWT_SECRET}"
JWT_EXPIRES_IN="15m"
JWT_REFRESH_EXPIRES_IN="7d"
APP_URL="${BACKEND_URL}"

# ---- Frontend ----
NEXT_PUBLIC_API_URL=http://backend:3001/api
FRONTEND_URL="${FRONTEND_URL}"

# ---- Admin ----
NEXT_PUBLIC_API_URL=http://backend:3001/api
ADMIN_URL="${ADMIN_URL}"

# ---- CORS ----
FRONTEND_URL="${FRONTEND_URL}"
ADMIN_URL="${ADMIN_URL}"

# ---- WeChat Pay (在管理后台「系统设置」中填写) ----
WECHAT_APP_ID=""
WECHAT_MCH_ID=""
WECHAT_API_KEY=""
WECHAT_NOTIFY_URL=""

# ---- Alipay (在管理后台「系统设置」中填写) ----
ALIPAY_APP_ID=""
ALIPAY_PRIVATE_KEY=""
ALIPAY_PUBLIC_KEY=""
ALIPAY_NOTIFY_URL=""

# ---- XUI Panel ----
XUI_PANELS='[]'

# ---- App Settings ----
APP_NAME="NodeShop"
EOF

  ok ".env 文件已生成"
}

# ============ 启动 Docker Compose ============
start_services() {
  info "构建并启动服务（首次约需 5-10 分钟）..."

  docker compose up -d --build --force-recreate 2>&1 | tail -5

  info "等待服务启动..."
  sleep 10

  # 等待 PostgreSQL 就绪
  local retries=30
  while [ $retries -gt 0 ]; do
    if docker exec nodeshop-db pg_isready -U nodeadmin -d nodeshop &>/dev/null; then
      ok "PostgreSQL 就绪"
      break
    fi
    retries=$((retries - 1))
    sleep 2
  done
  [ $retries -eq 0 ] && err "PostgreSQL 启动超时"

  # 等待 Redis 就绪
  retries=15
  while [ $retries -gt 0 ]; do
    if docker exec nodeshop-redis redis-cli ping 2>/dev/null | grep -q PONG; then
      ok "Redis 就绪"
      break
    fi
    retries=$((retries - 1))
    sleep 2
  done
  [ $retries -eq 0 ] && err "Redis 启动超时"

  # 等待 Backend 就绪
  retries=30
  while [ $retries -gt 0 ]; do
    if docker exec nodeshop-backend curl -s http://localhost:3001/api/system/settings &>/dev/null || \
       [ -f /opt/nodeshop/backend/dist/main.js ]; then
      ok "Backend 就绪"
      break
    fi
    retries=$((retries - 1))
    sleep 3
  done
}

# ============ 数据库迁移 + Seed ============
migrate_and_seed() {
  info "执行数据库迁移..."
  docker exec nodeshop-backend npx prisma migrate deploy 2>&1 | tail -3
  ok "数据库迁移完成"

  info "初始化管理员和系统设置..."
  docker exec -e SEED_ADMIN_EMAIL="$ADMIN_EMAIL" \
             -e SEED_ADMIN_PASSWORD="$ADMIN_PASS" \
             nodeshop-backend \
             npx prisma db seed 2>&1 | tail -5
  ok "初始化完成"
}

# ============ 安装 Nginx + SSL ============
setup_nginx() {
  if ! [ -n "$DOMAIN" ]; then
    info "未配置域名，跳过 Nginx"
    return
  fi

  info "安装 Nginx..."
  if [ "$OS" = "centos" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
    yum install -y nginx
  else
    apt-get install -y -qq nginx
  fi

  # 写入 Nginx 配置
  local SSL_BLOCK=""
  local LISTEN_PORT=80
  local ADMIN_LISTEN_PORT=80
  local PROTO="http"

  if [ "$USE_SSL" = true ]; then
    setup_certbot
    SSL_BLOCK="    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;"
    LISTEN_PORT="443 ssl"
    ADMIN_LISTEN_PORT="443 ssl"
    PROTO="https"
  fi

  cat > /etc/nginx/conf.d/nodeshop.conf <<NGINX
# NodeShop 前端
server {
    ${LISTEN_PORT:+listen $LISTEN_PORT;};
    server_name $DOMAIN;

    ${SSL_BLOCK}

    client_max_body_size 10M;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }

    # API 反向代理
    location /api/ {
        proxy_pass         http://127.0.0.1:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }
}

# NodeShop 管理后台
server {
    ${ADMIN_LISTEN_PORT:+listen $ADMIN_LISTEN_PORT;};
    server_name $ADMIN_DOMAIN;

    ${SSL_BLOCK}

    client_max_body_size 10M;

    location / {
        proxy_pass         http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }

    location /api/ {
        proxy_pass         http://127.0.0.1:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }
}
NGINX

  # 删除默认配置避免冲突
  rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

  systemctl enable nginx
  systemctl restart nginx
  ok "Nginx 配置完成"

  # HTTP → HTTPS 重定向
  if [ "$USE_SSL" = true ]; then
    info "配置 HTTP → HTTPS 自动重定向..."
    cat > /etc/nginx/conf.d/nodeshop-http-redirect.conf <<REDIR
server {
    listen 80;
    server_name $DOMAIN $ADMIN_DOMAIN;
    return 301 https://\$host\$request_uri;
}
REDIR
    systemctl reload nginx
  fi
}

# ============ 安装 Certbot ============
setup_certbot() {
  if command -v certbot &>/dev/null; then
    ok "Certbot 已安装"
  else
    info "安装 Certbot..."
    if [ "$OS" = "centos" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
      yum install -y epel-release
      yum install -y certbot python3-certbot-nginx
    else
      apt-get install -y -qq certbot python3-certbot-nginx
    fi
  fi

  info "申请 SSL 证书..."
  certbot certonly --nginx -d "$DOMAIN" -d "$ADMIN_DOMAIN" --non-interactive --agree-tos -m "$ADMIN_EMAIL" 2>&1 | tail -3

  # 自动续期定时任务
  (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'") | crontab -
  ok "SSL 证书申请完成，自动续期已配置"
}

# ============ 输出部署信息 ============
print_info() {
  local SERVER_IP
  SERVER_IP=$(hostname -I | awk '{print $1}')

  echo ""
  echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}    ✅ NodeShop 部署完成！${NC}"
  echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
  echo ""

  if [ -n "$DOMAIN" ]; then
    echo -e "  🌐 前端用户端:    ${PROTO}://$DOMAIN"
    echo -e "  ⚙️  管理后台:      ${PROTO}://$ADMIN_DOMAIN"
    echo -e "  📡 API 文档:      ${PROTO}://$DOMAIN/api/docs"
  else
    echo -e "  🌐 前端用户端:    http://$SERVER_IP:3000"
    echo -e "  ⚙️  管理后台:      http://$SERVER_IP:3002"
    echo -e "  📡 API 文档:      http://$SERVER_IP:3001/docs"
  fi

  echo ""
  echo -e "  ${CYAN}管理员账号:${NC}"
  echo -e "    📧 邮箱:    $ADMIN_EMAIL"
  echo -e "    🔑 密码:    $ADMIN_PASS"
  echo ""
  echo -e "  ${CYAN}数据库信息:${NC}"
  echo -e "    🔑 密码:    $DB_PASS"
  echo ""
  echo -e "  ${YELLOW}⚠️  请务必修改管理员默认密码！${NC}"
  echo -e "  ${YELLOW}⚠️  请到管理后台「系统设置」配置微信/支付宝支付参数${NC}"
  echo -e "  ${YELLOW}⚠️  请到管理后台「服务器管理」添加你的 XUI 面板${NC}"
  echo ""
  echo -e "  ${CYAN}服务管理命令:${NC}"
  echo -e "    查看状态:  docker compose -f $INSTALL_DIR/docker-compose.yml ps"
  echo -e "    查看日志:  docker compose -f $INSTALL_DIR/docker-compose.yml logs -f backend"
  echo -e "    重启服务:  docker compose -f $INSTALL_DIR/docker-compose.yml restart"
  echo -e "    停止服务:  docker compose -f $INSTALL_DIR/docker-compose.yml down"
  echo -e "    更新部署:  cd $INSTALL_DIR && bash deploy.sh --update"
  echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
}

# ============ 更新模式 ============
update_mode() {
  info "更新模式：拉取最新代码并重新部署..."
  cd "$INSTALL_DIR"
  git pull origin master
  docker compose up -d --build
  migrate_and_seed
  ok "更新完成"
  docker compose ps
}

# ============ 仅迁移模式 ============
migrate_mode() {
  info "仅迁移数据库..."
  cd "$INSTALL_DIR"
  docker compose up -d postgres redis
  sleep 5
  migrate_and_seed
  ok "数据库迁移完成"
}

# ============ 主流程 ============
main() {
  check_root
  detect_os

  case "$MODE" in
    --update|-u)
      install_docker
      update_mode
      ;;
    --migrate|-m)
      install_docker
      migrate_mode
      ;;
    *)
      install_git
      install_docker
      interactive_config
      clone_or_update
      generate_env
      start_services
      migrate_and_seed
      setup_nginx
      print_info
      ;;
  esac
}

main

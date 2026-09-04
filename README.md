# 售卖网站（NodeShop）— 综合型商业VPN节点售卖平台

一个完整的商业节点售卖系统：**前端用户端 + NestJS后端 + 管理后台**，对接 **3-XUI** 面板自动创建节点。

## 功能特性

- 🎯 **3-XUI 自动对接**：购买后自动在面板创建入站节点，返回连接信息
- 💳 **多种支付**：微信支付、支付宝、卡密兑换、余额支付
- 📡 **多协议支持**：VLESS / VMess / Trojan / Shadowsocks
- 🔄 **SOCKS5 中转**：用户自填 or 服务器自动创建
- 🌍 **中英双语**：满足国际化需求
- ⚙️ **完整管理后台**：用户/套餐/订单/服务器/节点/卡密/财务/工单/公告/设置
- 📱 **现代精美 UI**：Next.js + Tailwind + Framer Motion

## 技术栈

| 层 | 技术 |
|---|---|
| 前端（用户端） | Next.js 14 + Tailwind + shadcn/ui 风格 |
| 后端 | NestJS + TypeScript + Prisma |
| 管理后台 | Next.js 14（独立应用） |
| 数据库 | PostgreSQL + Redis |
| 认证 | JWT (access + refresh) |

## 目录结构

```
售卖网站/
├── backend/      # NestJS 后端 API (端口 3001)
├── frontend/     # 用户端 UI (端口 3000)
├── admin/        # 管理后台 UI (端口 3002)
├── docker-compose.yml
└── .env.example
```

## 快速开始（开发）

### 1. 启动数据库

```bash
docker-compose up -d postgres redis
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，设置数据库、JWT密钥等
```

### 3. 后端

```bash
cd backend
npm install
cp ../.env .env
npx prisma migrate dev   # 初始化数据库
npx prisma db seed       # 创建管理员 admin@nodeshop.com / admin123456
npm run start:dev        # http://localhost:3001/docs
```

### 4. 前端用户端

```bash
cd frontend
npm install
npm run dev              # http://localhost:3000
```

### 5. 管理后台

```bash
cd admin
npm install
npm run dev              # http://localhost:3002
```

使用 `admin@nodeshop.com / admin123456` 登录管理后台。

## XUI 面板对接

在后端 `.env` 配置你的 XUI 面板（或通过管理后台「服务器管理」添加）：

```env
XUI_PANELS='[{"name":"Server 1","url":"http://your-panel:54321","username":"admin","password":"admin"}]'
```

也可在管理后台「服务器管理」页面直接添加面板连接并点击「测试」验证。

### 支付配置

微信支付和支付宝参数在**管理后台「系统设置」中填写并保存**（数据库存储，不写入代码/环境变量）。

配置内容包括：
- **微信支付**：开启/关闭、APP ID、商户号、APIv2密钥、证书路径、回调地址
- **支付宝**：开启/关闭、APP ID、应用私钥、支付宝公钥、网关、回调地址

配置完成后前端即生成真实付款二维码，回调地址由后端自动处理。未配置完整的渠道会返回明确错误提示。

> ⚠️ 种子脚本不预置任何演示套餐（套餐由管理员在后台手动创建，保证真实可售卖）。

## 生产部署（一键部署）

在 Linux 服务器上执行一条命令即可完成全部部署：

```bash
git clone https://github.com/wstimin/syjdmb.git && cd syjdmb && sudo bash deploy.sh
```

脚本自动完成：
1. 安装 Docker + Docker Compose
2. 克隆项目代码
3. 生成随机 JWT 密钥和数据库密码
4. 构建并启动全部 5 个服务（PostgreSQL、Redis、Backend、Frontend、Admin）
5. 执行数据库迁移和初始化（管理员账号 + 系统设置）
6. 输出访问地址和登录凭据

部署完成后访问：
- 前端用户端：`http://服务器IP:3000`
- 管理后台：`http://服务器IP:3002`
- API 文档：`http://服务器IP:3001/docs`

### 更新部署

```bash
cd /opt/nodeshop && sudo bash deploy.sh
```

### 常用运维命令

```bash
docker compose -f /opt/nodeshop/docker-compose.yml logs -f backend   # 查看后端日志
docker compose -f /opt/nodeshop/docker-compose.yml restart           # 重启所有服务
docker compose -f /opt/nodeshop/docker-compose.yml down              # 停止所有服务
```

### 配置域名 + SSL（可选）

部署完成后如需配置域名和 HTTPS：

```bash
# 安装 Nginx
apt install -y nginx

# 安装 SSL 证书工具
apt install -y certbot python3-certbot-nginx

# 申请证书（替换为你的域名）
certbot --nginx -d your-domain.com -d admin.your-domain.com

# 自动续期
certbot renew --dry-run
```

## 默认管理员

- 邮箱：`admin@nodeshop.com`
- 密码：`admin123456`

⚠️ 生产环境请立即修改！

## 免责声明

本系统用于合法的网络服务管理。请遵守当地法律法规，不得用于任何违法用途。

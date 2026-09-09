# 售卖网站（NodeShop）— 面向跨境业务与 AI 用户的国际网络连接服务

一套完整的国际网络连接服务电商系统：**前端用户端 + NestJS 后端 + 管理后台**，对接 **3-XUI** 面板自动创建节点，即买即用。

面向**跨境电商**（访问海外市场、平台与工具）、**海外社媒运营**、**远程办公与团队协作**、**大数据同步**等行业用户，以及需要**直连访问 ChatGPT、Claude、Gemini 等 AI 服务与 API** 的用户。

## 功能特性

- 🎯 **3-XUI 自动对接**：购买后自动在面板创建入站节点，返回连接信息
- 💳 **多种支付**：微信支付、支付宝、卡密兑换、余额支付
- 📡 **多协议支持**：VLESS（+Reality）、VMess、Trojan、Shadowsocks
- 🔄 **SOCKS5 中转**：用户自填 or 服务器自动创建
- 📅 **套餐续费**：到期顺延（EXPIRY）或流量重置（TRAFFIC）两种续费类型，数据库级防重复下单
- 💰 **余额体系**：余额充值、消费与交易流水全记录
- 🎫 **优惠券**：优惠券折扣下单
- ↩️ **退款**：已支付订单可申请退款，审核通过后退至余额
- 🏷️ **卡密兑换**：卡密兑换与余额互通
- 🎫 **工单客服**：用户工单 + 管理端回复
- 📧 **邮件提醒**：购买/续费/工单等关键事件邮件通知
- 🛡️ **安全加固**：登录防爆破（限流）、JWT access + refresh 双令牌、支付回调验签、退款/余额操作的并发防重与 Redis 锁
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
├── deploy.sh     # 一站式部署/运维脚本（安装后命令为 shop）
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
npx prisma db seed       # 首次创建默认管理员（仅在用户表为空时创建，非空则跳过）
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

## 默认管理员

- 邮箱：`admin@nodeshop.com`（可用环境变量 `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` 覆盖）
- 密码：`admin123456`

⚠️ **只对全新数据库（用户表为空）创建一次**：数据库里一旦有任何用户，`prisma db seed` 与部署脚本都**不会重建或重置默认管理员**（避免每次部署用默认口令改写登录凭据的后门）。生产环境请立即修改。

若需重置管理员登录信息，在服务器上使用 `shop` → 菜单 **4 重置登录**。

## XUI 面板对接

在后端 `.env` 配置你的 XUI 面板（或通过管理后台「服务器管理」添加）：

```env
XUI_PANELS='[{"name":"Server 1","url":"http://your-panel:54321","username":"admin","password":"admin"}]'
```

也可在管理后台「服务器管理」页面直接添加面板连接并点击「测试」验证。

> 节点的创建/续费/停止/删除均通过面板 API 完成，面板配置错误会导致节点操作失败，请确保面板地址与凭据正确。

### 支付配置

微信支付和支付宝参数在**管理后台「系统设置」中填写并保存**（数据库存储，不写入代码/环境变量）。

配置内容包括：
- **微信支付**：开启/关闭、APP ID、商户号、APIv2密钥、证书路径、回调地址
- **支付宝**：开启/关闭、APP ID、应用私钥、支付宝公钥、网关、回调地址

配置完成后前端即生成真实付款二维码，回调地址由后端自动处理。未配置完整的渠道会返回明确错误提示。

卡密、优惠券、余额充值等在管理后台对应页面维护（无需环境变量）。

> ⚠️ 种子脚本不预置任何演示套餐（套餐由管理员在后台手动创建，保证真实可售卖）。

## 生产部署（一键安装）

在 **Linux 服务器（root）** 上执行下面这一条命令即可完成全部安装：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/syjdmb/master/deploy.sh)
```

脚本自动完成：
1. 自动安装 Docker + Docker Compose
2. 自动克隆项目代码
3. 让你输入管理员邮箱和密码（有默认值，回车即可）
4. 生成随机 JWT 密钥和数据库密码
5. 构建并启动全部 5 个服务（PostgreSQL、Redis、Backend、Frontend、Admin）
6. 自动执行数据库迁移和初始化（**仅在全新数据库时创建默认管理员，用户表非空则不覆盖**）
7. 输出访问地址和登录凭据

> 无需预先安装任何东西（除 root 权限），脚本会从头装好，全程只在你输入账号时停下。

部署完成后访问（地址使用**公网 IP**，非内网 IP）：
- 前端用户端：`http://公网IP:3000`
- 管理后台：`http://公网IP:3002`

> 后端 API 为**内置服务**，不对外提供端口/域名：公网请求统一走前端与管理后台的 `/api` 代理转发。接口文档（Swagger）配置域名后可在 `https://你的域名/docs` 查看。

**更新**：在服务器上执行 `shop`，选 **2 更新**。更新流程 = 拉取最新代码 → **直接下载 GitHub Actions 云端预编译好的镜像包并 `docker load`**（本机不再编译，通常 1–2 分钟）→ 启动新容器 → 自动迁移。若预编译包拉取失败会自动回退为服务器本机编译，功能不受影响。

> ⚙️ 预编译原理：仓库已配置 GitHub Actions 工作流 `.github/workflows/build.yml`——每次推送到 `master` 会自动在云端编译 backend/frontend/admin 三个 Docker 镜像，打包成 `nodeshop-images.tar.gz` 上传到仓库的滚动 Release（`nightly` 标签）。`deploy.sh` 从 `https://github.com/wstimin/syjdmb/releases/download/nightly/nodeshop-images.tar.gz` 拉取（仓库公开，无需任何凭证）。若 GitHub 仓库未启用 Actions，可在仓库 Settings → Actions ➜ 开启，或保持本机编译回退。

### 常用运维命令

```bash
shop                                # 管理菜单（查看信息/更新/回滚/重置登录/域名反代/日志）
docker compose -f /opt/nodeshop/docker-compose.yml logs -f backend   # 查看后端日志
docker compose -f /opt/nodeshop/docker-compose.yml restart           # 重启所有服务
docker compose -f /opt/nodeshop/docker-compose.yml down              # 停止所有服务
```

### 配置域名 + SSL（可选）

部署完成后在服务器上执行 `shop`，选 **5 添加域名 / 反向代理**（Caddy 自动申请并续期 HTTPS 证书，无需手动装 Nginx/certbot）：

- 只需输入**一个主域名**（如 `shop.example.com`），脚本自动创建两个对外地址：
  - `https://shop.example.com` → 前端用户端
  - `https://admin.shop.example.com` → 管理后台
- 后端 API **不配置独立域名**（内置服务，经前端 `/api` 代理访问，文档见 `https://shop.example.com/docs`）
- ⚠️ 配置前请先把这两个域名解析（DNS A 记录）到本机公网 IP，证书签发后即可 HTTPS 访问

## 免责声明

本系统用于合法的网络服务管理。请遵守当地法律法规，不得用于任何违法用途。
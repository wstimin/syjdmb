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

## 生产部署

```bash
docker-compose up -d --build
```

然后通过 Nginx 反向代理配置域名 + SSL。详见各服务 `Dockerfile`。

## 默认管理员

- 邮箱：`admin@nodeshop.com`
- 密码：`admin123456`

⚠️ 生产环境请立即修改！

## 免责声明

本系统用于合法的网络服务管理。请遵守当地法律法规，不得用于任何违法用途。

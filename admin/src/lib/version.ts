// 版本号单一来源：读取 admin/package.json 的 version 字段。
// 侧边栏、登录页、仪表盘共用，升级版本时只需改 package.json。
import pkg from '../../package.json';

export const APP_VERSION = pkg.version;
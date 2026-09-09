-- 订阅周期制改造：Inbound 记录「周期基础额度」与「周期切换点」，Order 记录「是否周期重置续费」
--
-- 目标模型（用户确认的订阅周期制）：
--  - EXPIRY（到期续费）：到期日顺延。节点未到期 → 流量在当前周期内不变，到「周期切换点」
--    （即当前到期日）由 cron 自动清零已用、额度回归套餐满额、保持启用；节点已到期（一天
--    续费宽限期内）→ 新周期锚在原到期日（新到期日=原到期日+时长），切换点已过 → 激活即按
--    周期切换恢复满额。过期超过一天的节点由 cron 自动删除，只能重新购买套餐（一天宽限期）。
--  - TRAFFIC（流量续费）：在当前流量额度上叠加套餐流量，不清已用；叠加量随本周期结束清零。
--
-- 新字段：
--  Inbound.periodQuota    每周期套餐额度（byte），周期切换后 trafficLimit 回归此值
--  Inbound.trafficResetAt 下一次自动重置流量的时刻（=当前周期结束点），cron 到点判断
--  Order.renewalResetTraffic 该续费单伴随周期重置（已到期 EXPIRY：切换点已过→激活即周期切换），settle 对账用

-- AlterTable: Inbound 增加 periodQuota 与 trafficResetAt
ALTER TABLE "Inbound" ADD COLUMN "periodQuota" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Inbound" ADD COLUMN "trafficResetAt" TIMESTAMP(3);

-- AlterTable: Order 增加 renewalResetTraffic
ALTER TABLE "Order" ADD COLUMN "renewalResetTraffic" BOOLEAN NOT NULL DEFAULT false;

-- 存量回填：现有限流量节点把「当前流量额度」视为周期基础额度；有到期日的节点把到期日
-- 作为第一个周期切换点（到期未续费时切换点=到期日 — cron 见 expiresAt==switchAt 走正常
-- 到期停用，不会误判切换；已续费推后到期日的节点才在旧到期日触发自动重置）。
UPDATE "Inbound"
SET "periodQuota" = "trafficLimit", "trafficResetAt" = "expiryTime"
WHERE "trafficLimit" > 0 AND "expiryTime" IS NOT NULL;
import { cn } from '@/lib/utils';

/**
 * NodeShop 品牌标识：全球节点互联
 * ---------------------------------
 * 图形语义 = 品牌定位「全球节点，一网直连」：
 *  - 外环：球体轮廓（全球覆盖）
 *  - 赤道弧 + 经线弧：球面经纬（international）
 *  - 中心核 + 三个卫星节点 + 连接弧线：网络拓扑（node）
 * 白色描边绘制在品牌渐变底上，任意尺寸下保持等比例清晰。
 */
export function BrandLogo({
  className,
  size = 36,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-[10px] bg-gradient-primary shadow-sm',
        className
      )}
      style={{ width: size, height: size }}
      role="img"
      aria-label="NodeShop"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        strokeWidth={1.55}
        strokeLinecap="round"
        className="opacity-95"
        style={{ width: size * 0.62, height: size * 0.62 }}
      >
        {/* 球体轮廓 */}
        <circle cx="12" cy="12" r="9.3" opacity={0.9} />

        {/* 赤道弧 */}
        <path d="M3.4 9.6c2.9 1.6 5.6 2.4 8.6 2.4s5.7-.8 8.6-2.4" opacity={0.75} />

        {/* 经线弧（左） */}
        <path d="M6.2 3.8c1 2.3 1.5 5 1.5 7.7s-.5 5.4-1.5 7.7" opacity={0.55} />

        {/* 卫星节点连接弧，汇聚向中心核 */}
        <path d="M12 2.9v3.2" />
        <path d="M12 17.9v3.2" opacity={0.85} />
        <path d="M2.9 12h3.4" opacity={0.85} />
        <path d="M17.7 12h3.4" />

        {/* 卫星节点：上/下/左（右端点位留给连接开口） */}
        <circle cx="12" cy="2.9" r="1.15" fill="white" stroke="none" />
        <circle cx="12" cy="21.1" r="1.15" fill="white" stroke="none" opacity={0.85} />
        <circle cx="2.9" cy="12" r="1.15" fill="white" stroke="none" opacity={0.85} />

        {/* 中心核心节点 */}
        <circle cx="12" cy="12" r="1.7" fill="white" stroke="none" />
      </svg>

      {/* 底部一抹高光，提升质感 */}
      <div
        className="pointer-events-none absolute inset-0 rounded-[10px]"
        style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 45%)' }}
      />
    </div>
  );
}
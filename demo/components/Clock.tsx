import { useEffect, useState } from 'react';

/** 可复用组件：位于 components/（不在 pages/ 下，因此不会被注入 data-node-id） */
export default function Clock({ label = '服务器时间' }: { label?: string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div style={{ fontSize: 12, color: '#64748b' }}>
      {label}: {now.toLocaleTimeString('zh-CN', { hour12: false })}
    </div>
  );
}

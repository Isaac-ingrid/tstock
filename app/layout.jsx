import '../css/style.css';
import '../css/nav.css';
import '../css/anim.css';

export const metadata = {
  title: '智策战情室 · A股多维选股与实战终端',
  description: 'A股起爆挖掘、龙头抄底、连板情绪、尾盘黑马、盘中做T与策略战绩回算系统',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/favicon.svg',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

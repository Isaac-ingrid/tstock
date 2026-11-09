import '../css/style.css';
import '../css/nav.css';
import '../css/anim.css';

export const metadata = {
  title: '做T执行台 · 七格箱体 + 七底三仓',
  description: 'A股选股、做T执行与台账回算工作台',
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

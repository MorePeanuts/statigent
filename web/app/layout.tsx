import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";
import styles from "./layout.module.css";

export const metadata: Metadata = {
  title: "Statigent 工作台",
  description: "本机 EDA 智能体工作台",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <header className={styles.header}>
          <Link href="/" className={styles.brand}>
            Statigent 工作台
          </Link>
          <nav className={styles.nav}>
            <Link href="/">新建分析</Link>
            <Link href="/runs">运行历史</Link>
          </nav>
          <span className={styles.scope}>本机 · 单用户</span>
        </header>
        <main className={styles.main}>{children}</main>
      </body>
    </html>
  );
}

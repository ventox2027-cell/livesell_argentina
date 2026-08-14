import type { Metadata } from 'next';
import './globals.css';

import { Sidebar } from '@/components/sidebar';

export const metadata: Metadata = {
  title: 'VendoX · Admin',
  description: 'Herramienta de operación y soporte',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <Sidebar />
        {children}
      </body>
    </html>
  );
}

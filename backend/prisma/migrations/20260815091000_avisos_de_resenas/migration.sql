-- Tipos de aviso nuevos.
--
-- ALTER TYPE ... ADD VALUE no puede correr dentro de una transacción en
-- PostgreSQL y Prisma envuelve cada migración en una. Van con IF NOT EXISTS y
-- en su propio archivo: si fallara a la mitad, volver a correrla no rompe.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_ANSWERED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SAVED_BACK_IN_STOCK';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LIVE_SOON';

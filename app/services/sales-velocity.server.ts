/**
 * Sales velocity: units sold per day for reorder calculations.
 */

import prisma from "../db.server";

export async function recordSales(
  shopId: string,
  variantId: string,
  date: Date,
  unitsSold: number
): Promise<void> {
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  await prisma.salesDaily.upsert({
    where: {
      variantId_date: { variantId, date: dateOnly },
    },
    create: { shopId, variantId, date: dateOnly, unitsSold },
    update: { unitsSold: { increment: unitsSold }, updatedAt: new Date() },
  });
}

export async function getVelocity(
  variantId: string,
  windowDays: number
): Promise<number> {
  const since = new Date();
  since.setDate(since.getDate() - windowDays);
  since.setHours(0, 0, 0, 0);

  const rows = await prisma.salesDaily.findMany({
    where: { variantId, date: { gte: since } },
    select: { unitsSold: true },
  });

  const total = rows.reduce((sum, r) => sum + r.unitsSold, 0);
  return windowDays > 0 ? total / windowDays : 0;
}

/** Velocity for a custom date range. */
export async function getVelocityForDateRange(
  variantId: string,
  startDate: Date,
  endDate: Date
): Promise<number> {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const rows = await prisma.salesDaily.findMany({
    where: { variantId, date: { gte: start, lte: end } },
    select: { unitsSold: true },
  });

  const total = rows.reduce((sum, r) => sum + r.unitsSold, 0);
  const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
  return total / days;
}

/** Same period last year: units sold per day for the same date range last year. */
export async function getVelocityYoY(
  variantId: string,
  windowDays: number
): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = new Date(today);
  since.setDate(since.getDate() - windowDays);

  const sinceLastYear = new Date(since.getFullYear() - 1, since.getMonth(), since.getDate());
  const todayLastYear = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());

  const rows = await prisma.salesDaily.findMany({
    where: {
      variantId,
      date: { gte: sinceLastYear, lte: todayLastYear },
    },
    select: { unitsSold: true },
  });

  const total = rows.reduce((sum, r) => sum + r.unitsSold, 0);
  return windowDays > 0 ? total / windowDays : 0;
}

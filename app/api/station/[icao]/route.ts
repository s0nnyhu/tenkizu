import { NextResponse } from "next/server";
import { buildStation } from "@/lib/dashboard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ icao: string }> },
) {
  try {
    const { icao } = await ctx.params;
    const data = await buildStation(icao);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /Aucun marché/.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

import { NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { buildStationIndex } from "@/lib/dashboard";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    const data = await cached("dashboard:index", 45_000, () => buildStationIndex(), 180_000);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

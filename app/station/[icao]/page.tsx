import { StationDetail } from "@/components/StationDetail";

export default async function Page({ params }: { params: Promise<{ icao: string }> }) {
  const { icao } = await params;
  return <StationDetail icao={icao} />;
}

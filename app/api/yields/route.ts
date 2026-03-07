import { NextResponse } from "next/server";
import { getBaseYields, searchYields } from "@/lib/defi/yields";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q");

    // Validate query length to prevent excessive string matching
    if (query && query.length > 100) {
      return NextResponse.json({ error: "Query too long" }, { status: 400 });
    }

    const pools = query ? await searchYields(query) : await getBaseYields();

    return NextResponse.json({ pools });
  } catch (error) {
    console.error("Yields API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch yields" },
      { status: 500 }
    );
  }
}

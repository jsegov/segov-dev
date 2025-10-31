import { NextResponse } from "next/server";
import { getCareerEntries } from "@/lib/content";

export const revalidate = 3600; // ISR - revalidate at most once per hour

export async function GET() {
  try {
    const careerEntries = await getCareerEntries();
    return NextResponse.json({ careerEntries });
  } catch (error) {
    console.error("[CAREER API] Error fetching career data:", error);
    return NextResponse.json(
      { error: "Failed to fetch career data" },
      { status: 500 }
    );
  }
} 
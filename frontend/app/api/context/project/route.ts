import { NextResponse } from "next/server";
import { getProjects } from "@/lib/content";

export const revalidate = 3600;

export async function GET() {
  try {
    const projectEntries = await getProjects();
    return NextResponse.json({ projectEntries });
  } catch (error) {
    console.error("[PROJECT API] Error fetching project data:", error);
    return NextResponse.json(
      { error: "Failed to fetch project data" },
      { status: 500 }
    );
  }
} 
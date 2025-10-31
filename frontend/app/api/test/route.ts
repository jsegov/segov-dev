import { NextResponse } from "next/server"

// Simple API endpoint for testing connectivity
export async function GET() {
  return NextResponse.json({ status: "ok", message: "API is working" })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    return NextResponse.json({
      status: "ok",
      message: "POST request received successfully",
      receivedData: body,
    })
  } catch (error) {
    console.error("Error in test API:", error)
    return NextResponse.json(
      {
        status: "error",
        message: "Failed to parse request body",
      },
      { status: 400 },
    )
  }
}

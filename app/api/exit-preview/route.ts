import { type NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  // Clear the preview cookies
  const response = NextResponse.redirect(new URL("/", request.url))

  response.cookies.delete("__prerender_bypass")
  response.cookies.delete("__next_preview_data")

  return response
}

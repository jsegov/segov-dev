import { type NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const secret = searchParams.get("secret")
  const slug = searchParams.get("slug")
  const type = searchParams.get("type") || "blog" // Default to blog

  // Check the secret and slug
  if (secret !== process.env.CONTENTFUL_PREVIEW_SECRET || !slug) {
    return NextResponse.json({ message: "Invalid token or missing slug" }, { status: 401 })
  }

  // Enable Preview Mode by setting the cookies
  const response = NextResponse.redirect(
    new URL(type === "project" ? `/projects/${slug}` : `/blog/${slug}`, request.url),
  )

  response.cookies.set("__prerender_bypass", process.env.CONTENTFUL_PREVIEW_SECRET || "")
  response.cookies.set("__next_preview_data", process.env.CONTENTFUL_PREVIEW_SECRET || "")

  return response
}

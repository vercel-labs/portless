import { HOME_OG_TITLE } from "@/lib/page-titles";
import { renderLabsOg } from "./labs-og";

export async function GET() {
  return renderLabsOg({
    product: "portless",
    title: HOME_OG_TITLE,
  });
}

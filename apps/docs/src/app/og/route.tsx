import { renderLabsOg } from "./labs-og";

export async function GET() {
  return renderLabsOg({
    product: "portless",
    title: "Replace port numbers with named URLs",
  });
}

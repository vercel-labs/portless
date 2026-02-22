import { Links, Meta, Outlet, Scripts } from "react-router";

export default function Root() {
  return (
    <html>
      <head><Meta /><Links /></head>
      <body><Outlet /><Scripts /></body>
    </html>
  );
}

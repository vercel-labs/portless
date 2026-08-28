import createMDX from "@next/mdx";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  serverExternalPackages: ["just-bash", "bash-tool"],
  outputFileTracingIncludes: {
    "/*": ["./src/app/**/*.mdx"],
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/index.md", destination: "/api/docs-md" },
        { source: "/:path*.md", destination: "/api/docs-md/:path*" },
      ],
    };
  },
};

export default withMDX(nextConfig);

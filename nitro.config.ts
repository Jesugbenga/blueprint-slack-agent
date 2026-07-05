export default defineNitroConfig({
  srcDir: "server",
  compatibilityDate: "2025-07-27",
  modules: ["@workflow/nitro"],
  // Give AI generation (design/scaffold) room to finish; the Vercel default is
  // short and was cutting off long model calls mid-request.
  vercel: {
    functions: {
      maxDuration: 60,
    },
  },
});

export default {
  fetch(request) {
    const url = new URL(request.url);

    // No API is served from the app origin — production calls VITE_API_BASE_URL and dev
    // goes through the vite proxy to the API server. Answering 404 (never a fake 200)
    // makes a misrouted /api call fail loudly instead of "succeeding" with junk (BUG-008).
    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        {
          error: {
            code: "NOT_FOUND",
            message:
              "The app origin serves no API. Check VITE_API_BASE_URL (prod) or the vite dev proxy target.",
          },
        },
        { status: 404 },
      );
    }
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// Analytics DTOs. Mirrors src/types/form.ts shape — admin CRUD, snippet,
// and stats responses. Keeps the FE DTO contract independent of the BE
// route file so refactors on either side don't cascade.

export type AnalyticsStatus = "active" | "disabled";

// Admin: returned by GET /api/analytics, GET /api/analytics/:id,
// PUT /api/analytics/:id, GET /api/analytics/by-project/:projectId.
export interface AnalyticsConfigDTO {
  id: number;
  projectId: number;
  projectName: string;
  name: string;
  // 22-char credential used in the public script URL.
  // Server-generated at create time, immutable thereafter.
  secretToken: string;
  allowedOrigins: string[];
  status: AnalyticsStatus;
  createdAt: string;
  updatedAt: string;
}

// PUT /api/analytics/:id body. projectId and secretToken are immutable
// post-create (the BE rejects any payload containing them).
export interface AnalyticsConfigUpdateDTO {
  name?: string;
  allowedOrigins?: string[];
  status?: AnalyticsStatus;
}

// Snippet response from GET /api/analytics/:id/snippet.
export interface AnalyticsSnippetResponse {
  html: string;
  scriptUrl: string;
  secretToken: string;
  origin: string;
  allowedOrigins: string[];
}

// Stats response from GET /api/analytics/:id/stats.
export interface AnalyticsStatsResponse {
  days: number;
  // "hour" for windows <=7d, "day" for larger windows. Tells the FE how
  // to format the x-axis labels on the time-series chart.
  bucket: "hour" | "day";
  totals: {
    pageviews: number;
    events: number;
    uniqueVisitors: number;
    uniqueSessions: number;
  };
  timeSeries: Array<{
    // ISO 8601 bucket start (truncated to hour or day server-side).
    bucket: string;
    pageviews: number;
    events: number;
    visitors: number;
  }>;
  topPaths: Array<{ path: string; views: number }>;
  topReferrers: Array<{ host: string; visits: number }>;
  topLocales: Array<{ locale: string; visits: number }>;
  // All four keys are always present; missing buckets are 0.
  devices: {
    mobile: number;
    tablet: number;
    desktop: number;
    unknown: number;
  };
  // Flat array of (dow, hour) → events. The FE pivots to a 7x24 grid.
  // dow: 0=Sunday..6=Saturday (matches JS Date.getDay()).
  hourlyHeatmap: Array<{ dow: number; hour: number; events: number }>;
  realtime: {
    total30m: { pageviews: number; events: number };
    // 30 contiguous 1-minute buckets, oldest first.
    series: Array<{
      bucket: string;
      pageviews: number;
      events: number;
    }>;
  };
  recent: Array<{
    id: number;
    eventType: string;
    occurredAt: string;
    path: string | null;
    referrer: string | null;
    locale: string | null;
    sessionId: string | null;
  }>;
}

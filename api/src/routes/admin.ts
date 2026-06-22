import { Hono } from 'hono';
import type { AppBindings } from '../middleware/auth.js';

export const admin = new Hono<AppBindings>();

admin.get('/stats', async (c) => {
  const db = c.get('adminDb'); // admin client bypasses RLS
  const userId = c.get('userId');

  // Verify that the caller is an admin user
  const { data: callerProfile, error: callerErr } = await db
    .from('profiles')
    .select('username')
    .eq('id', userId)
    .single();

  if (callerErr || !callerProfile) {
    return c.json({ error: 'Caller profile not found' }, 404);
  }

  const username = callerProfile.username;
  const isAdmin = username && (
    username === 'imrajeshkr' ||
    username.startsWith('imrajeshkr') ||
    username.startsWith('kitabtest') ||
    username === 'admin'
  );

  if (!isAdmin) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Fetch profiles (max 1000 for safe bounds, currently 29)
  const { data: profiles, error: errP } = await db
    .from('profiles')
    .select('username, display_name, is_guest, language, created_at')
    .order('created_at', { ascending: false });
  if (errP) throw errP;

  // Fetch events (last 10,000 events, currently ~1500)
  const { data: events, error: errE } = await db
    .from('events')
    .select('type, created_at, user_id')
    .order('created_at', { ascending: false })
    .limit(10000);
  if (errE) throw errE;

  // Fetch sits (last 10,000 sits)
  const { data: sits, error: errS } = await db
    .from('sits')
    .select('completed_at, created_at')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (errS) throw errS;

  // Fetch weather checkins (last 5000 checkins)
  const { data: weatherCheckins, error: errW } = await db
    .from('weather_checkins')
    .select('weather, created_at')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (errW) throw errW;

  // Other simple counts
  const { count: reflectionsCount } = await db
    .from('reflections')
    .select('*', { count: 'exact', head: true });

  const { count: highlightsCount } = await db
    .from('highlights')
    .select('*', { count: 'exact', head: true });

  const { count: savedItemsCount } = await db
    .from('saved_items')
    .select('*', { count: 'exact', head: true });

  // Compile calculations
  const totalProfiles = profiles.length;
  const guestProfiles = profiles.filter(p => p.is_guest).length;
  const registeredProfiles = profiles.filter(p => !p.is_guest).length;

  // En vs Hi
  const languageBreakdown = profiles.reduce((acc, p) => {
    const lang = p.language || 'en';
    acc[lang] = (acc[lang] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Event types breakdown
  const eventTypeBreakdown = events.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Mood/Weather breakdown
  const moodBreakdown = weatherCheckins.reduce((acc, wc) => {
    acc[wc.weather] = (acc[wc.weather] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Time series helper (last 30 days)
  const last30Days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0] || '';
    last30Days.push(dateStr);
  }

  // Registrations over last 30 days
  const signupSeries = last30Days.map(date => {
    const count = profiles.filter(p => typeof p.created_at === 'string' && p.created_at.startsWith(date)).length;
    return { date, count };
  });

  // Daily Active Users over last 30 days (DAU) - active means logged an event
  const dauSeries = last30Days.map(date => {
    const activeUsers = new Set(
      events
        .filter(e => typeof e.created_at === 'string' && e.created_at.startsWith(date))
        .map(e => e.user_id)
    );
    return { date, count: activeUsers.size };
  });

  // WAU (7 days) & MAU (30 days)
  const now = new Date();
  const ms7DaysAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const ms30DaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  const wauUsers = new Set(
    events
      .filter(e => typeof e.created_at === 'string' && new Date(e.created_at).getTime() >= ms7DaysAgo)
      .map(e => e.user_id)
  );

  const mauUsers = new Set(
    events
      .filter(e => typeof e.created_at === 'string' && new Date(e.created_at).getTime() >= ms30DaysAgo)
      .map(e => e.user_id)
  );

  // Sits completed
  const completedSitsCount = sits.filter(s => s.completed_at !== null).length;

  return c.json({
    summary: {
      totalUsers: totalProfiles,
      guestUsers: guestProfiles,
      registeredUsers: registeredProfiles,
      wau: wauUsers.size,
      mau: mauUsers.size,
      reflections: reflectionsCount || 0,
      highlights: highlightsCount || 0,
      savedItems: savedItemsCount || 0,
      completedSits: completedSitsCount,
      totalEvents: events.length,
    },
    languageBreakdown,
    eventTypeBreakdown,
    moodBreakdown,
    signupSeries,
    dauSeries,
    recentRegistrations: profiles.slice(0, 30), // List of recent accounts
  });
});

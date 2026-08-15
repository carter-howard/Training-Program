import React, { useState, useMemo, useEffect, useCallback } from "react";
import { Waves, Bike, Footprints, Dumbbell, Plane, RotateCcw, Target, ChevronRight, ChevronLeft, Calendar as CalIcon, TrendingUp, CheckCircle2, Circle, LayoutGrid, X, BarChart3 } from "lucide-react";
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceArea, ReferenceLine, ReferenceDot } from "recharts";

// ---------- safe storage (works once deployed; no-ops silently in the sandboxed Claude.ai preview) ----------
const STORAGE_KEY = "ironman-plan-completion-v1";
function loadCompletion() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    // storage unavailable — fall through to default seed
  }
  return { "2026-08-15::0": true }; // today's ride already happened
}
function saveCompletion(data) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // storage unavailable (e.g. sandboxed preview) — state still works in-memory for this session
  }
}

const COLORS = {
  bg: "#0B0E11",
  surface: "#12161B",
  surface2: "#181D24",
  line: "#242A32",
  text: "#EDEAE2",
  muted: "#8A9099",
  swim: "#4A9FD8",
  bike: "#D9713C",
  run: "#6FA26F",
  lift: "#B79A6B",
  rest: "#4A5058",
};

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');`;

// ---------- helpers ----------
const disciplineMeta = {
  swim: { icon: Waves, color: COLORS.swim, label: "Swim" },
  bike: { icon: Bike, color: COLORS.bike, label: "Bike" },
  run: { icon: Footprints, color: COLORS.run, label: "Run" },
  lift: { icon: Dumbbell, color: COLORS.lift, label: "Strength" },
  travel: { icon: Plane, color: COLORS.muted, label: "Travel" },
  rest: { icon: RotateCcw, color: COLORS.rest, label: "Rest" },
};

// ---------- pace model (derived from real Strava zones — see ZONES below) ----------
const PACE = {
  runEasy: 9.3,        // min/mi, mid-Z2 (real Z2: 8:27–9:49/mi)
  runSteady: 8.0,       // min/mi, mid-Z3 (7:35–8:27/mi)
  runThreshold: 7.3,    // min/mi, mid-Z4 (7:06–7:35/mi)
  bikeEasy: 14,         // mph, Z1 recovery
  bikeZ2: 15.5,          // mph, Z2 endurance — matches actual logged Z2 rides
  bikeTempo: 17.5,       // mph, Z3-Z4 tempo
  bikeTest: 16,          // mph, blended warm-up/test/cool-down
  swim100y: 2.0,         // min per 100y, moving pace
};

const ZONES = {
  ftp: 174,
  ftpEstimated: true,
  hr: [
    { n: 1, label: "Recovery", range: "< 123 bpm" },
    { n: 2, label: "Aerobic / Endurance", range: "123–151 bpm" },
    { n: 3, label: "Tempo", range: "152–166 bpm" },
    { n: 4, label: "Threshold", range: "167–181 bpm" },
    { n: 5, label: "VO2max+", range: "182+ bpm" },
  ],
  power: [
    { n: 1, label: "Active Recovery", range: "< 97 W" },
    { n: 2, label: "Endurance", range: "97–131 W" },
    { n: 3, label: "Tempo", range: "132–157 W" },
    { n: 4, label: "Threshold", range: "158–183 W" },
    { n: 5, label: "VO2max", range: "184–209 W" },
    { n: 6, label: "Anaerobic", range: "210–261 W" },
    { n: 7, label: "Neuromuscular", range: "262+ W" },
  ],
  run: [
    { n: 1, label: "Recovery", range: "slower than 9:49/mi" },
    { n: 2, label: "Aerobic / Endurance", range: "8:27–9:49/mi" },
    { n: 3, label: "Tempo", range: "7:35–8:27/mi" },
    { n: 4, label: "Threshold", range: "7:06–7:35/mi" },
    { n: 5, label: "VO2max", range: "6:40–7:06/mi" },
    { n: 6, label: "Anaerobic", range: "faster than 6:40/mi" },
  ],
  note: "Pulled directly from your Strava zones (max-HR based HR zones, power zones off an estimated 174W FTP, run pace zones off an estimated 22:03 5K). These will sharpen once the Week 3 benchmark tests give real, measured numbers instead of estimates.",
};

function toMinutes(raw) {
  const s = raw.replace(/min|total/gi, "").trim();
  if (s.includes(":")) {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function parseTimeStr(str) {
  if (!str || str === "—") return null;
  const parts = str.split("-").map((s) => s.trim());
  const vals = parts.map(toMinutes);
  if (vals.some((v) => v == null)) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function estimateDistanceRaw(discipline, title, timeStr) {
  const lower = (title || "").toLowerCase();
  if (discipline === "swim" && (lower.includes("400m") || lower.includes("time trial"))) {
    return { value: 437, unit: "yd" };
  }
  const t = parseTimeStr(timeStr);
  if (t == null) return null;
  if (discipline === "run") {
    let pace = PACE.runEasy;
    if (lower.includes("threshold")) pace = PACE.runThreshold;
    else if (lower.includes("steady")) pace = PACE.runSteady;
    return { value: t / pace, unit: "mi" };
  }
  if (discipline === "bike") {
    let mph = PACE.bikeZ2;
    if (lower.includes("tempo-lite")) mph = 15;
    else if (lower.includes("tempo")) mph = PACE.bikeTempo;
    else if (lower.includes("ftp") || lower.includes("field test")) mph = PACE.bikeTest;
    else if (lower.includes("easy spin")) mph = PACE.bikeEasy;
    return { value: (t / 60) * mph, unit: "mi" };
  }
  if (discipline === "swim") {
    let factor = 0.75;
    if (lower.includes("lesson")) factor = 0.55;
    else if (lower.includes("technique")) factor = 0.7;
    else if (lower.includes("recovery")) factor = 0.85;
    else if (lower.includes("easy aerobic")) factor = 0.9;
    return { value: ((t * factor) / PACE.swim100y) * 100, unit: "yd" };
  }
  return null;
}
function formatDistance(raw) {
  if (!raw) return null;
  if (raw.unit === "mi") return `~${raw.value.toFixed(raw.value < 10 ? 1 : 0)} mi`;
  if (raw.unit === "yd") return `~${Math.round(raw.value / 25) * 25} yd`;
  return null;
}
function estimateDistance(discipline, title, timeStr, override) {
  if (override) return override;
  if (discipline === "swim" && (title || "").toLowerCase().includes("400m")) {
    return "400m (~440 yd) — fixed benchmark distance";
  }
  return formatDistance(estimateDistanceRaw(discipline, title, timeStr));
}

function Pill({ discipline, children }) {
  const m = disciplineMeta[discipline];
  const Icon = m.icon;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      background: m.color + "1c", color: m.color, border: `1px solid ${m.color}44`,
      borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 600,
      letterSpacing: 0.3, textTransform: "uppercase", fontFamily: "Oswald, sans-serif",
    }}>
      <Icon size={13} /> {children}
    </span>
  );
}

function SectionHeading({ eyebrow, title, sub }) {
  return (
    <div style={{ marginBottom: 28 }}>
      {eyebrow && (
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: COLORS.bike, letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>
          {eyebrow}
        </div>
      )}
      <h2 style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 30, letterSpacing: 0.5, margin: 0, color: COLORS.text }}>{title}</h2>
      {sub && <p style={{ color: COLORS.muted, marginTop: 8, fontSize: 15, lineHeight: 1.6, maxWidth: 680 }}>{sub}</p>}
    </div>
  );
}

// ---------- data ----------
const PHASES = [
  { n: 1, name: "Foundation & Swim Technique", range: "Aug 17 – Oct 25, 2026", weeks: "Weeks 1–10", color: COLORS.swim,
    desc: "Rebuild swimming from near-zero with lesson-driven technique work while maintaining current run strength and bike aerobic base. Includes the Sept 11–26 Europe running-only block." },
  { n: 2, name: "Aerobic Build", range: "Oct 26 – Dec 27, 2026", weeks: "Weeks 11–19", color: COLORS.bike,
    desc: "Extend long ride and long run durations. Add swim endurance sets beyond technique work. Introduce structured bike power intervals now that a base FTP estimate exists." },
  { n: 3, name: "Race-Specific Build", range: "Dec 28, 2026 – Feb 21, 2027", weeks: "Weeks 20–27", color: COLORS.run,
    desc: "Race-pace swim, bike, and run sessions. First brick workouts. Nutrition and pacing rehearsal begins. The Austin Half Marathon on Feb 14 sits right in this phase — a real fitness check with a short taper before and easy rebound after, not just an extra hard training day." },
  { n: 4, name: "Peak", range: "Feb 22 – Mar 21, 2027", weeks: "Weeks 28–31", color: COLORS.lift,
    desc: "Highest-volume weeks of the plan. Longest brick session. Final benchmark tests before taper. Strength volume drops to protect key sessions." },
  { n: 5, name: "Taper", range: "Mar 22 – Apr 11, 2027", weeks: "Weeks 32–34", color: "#C4574A",
    desc: "Volume drops sharply, intensity stays sharp. Race week logistics, travel, and equipment checks." },
];

// Week 1 — full daily detail
const WEEK1 = {
  label: "Week 1", range: "Aug 17 – 23, 2026", note: "Baseline week. First stroke assessment lesson gets booked here — everything else holds at or slightly below current volume while that's arranged.",
  days: [
    { day: "Mon 8/17", sessions: [
      { d: "swim", title: "First Stroke Assessment (Lesson)", time: "45 min", detail: "Book a 1:1 lesson or stroke-assessment session with a coach this week. Goal is diagnosis, not fitness: body position, breathing pattern, catch mechanics. Take notes immediately after — those notes drive Wednesday's drill set." },
      { d: "lift", title: "Strength — Push", time: "50 min", detail: "Bench or DB press 4×6-8, incline DB press 3×8-10, overhead triceps extension 3×10-12, cable/band fly 2×12-15. RIR 2 on all sets." },
    ]},
    { day: "Tue 8/18", sessions: [
      { d: "run", title: "Easy Aerobic Run", time: "40 min", detail: "Strict Z2, conversational pace. This is a floor, not a workout — resist the urge to push it." },
      { d: "rest", title: "Mobility / Rest", time: "—", detail: "Light stretching or full rest. No structured session." },
    ]},
    { day: "Wed 8/19", sessions: [
      { d: "swim", title: "Technique Drills", time: "45 min", detail: "Warm-up 200y easy. Drill set built from Monday's lesson notes (likely body position + catch drills). Main set: 8×50y easy with 20s rest, focus only on the cue from the lesson. Cool-down 100y." },
      { d: "lift", title: "Strength — Pull", time: "50 min", detail: "Pull-ups or lat pulldown 4×6-8, DB/barbell row 3×8-10, face pulls 3×12-15, bicep curl 2×10-12. RIR 2." },
    ]},
    { day: "Thu 8/20", sessions: [
      { d: "bike", title: "Tempo Intervals (trainer)", time: "60 min", detail: "20 min Z2 warm-up. 3×8 min at moderate/tempo effort (comfortably hard, RPE 6-7) with 3 min easy spin between. 20 min Z2 cool-down. Watch cadence — target 75-85rpm through the tempo blocks." },
      { d: "lift", title: "Strength — Shoulders", time: "45 min", detail: "Standing OHP 4×6-8, lateral raise 3×12-15, rear delt fly 3×12-15, band external rotation 3×15 light, Bulgarian split squat 3×8/leg, plank 3×45s." },
    ]},
    { day: "Fri 8/21", sessions: [
      { d: "swim", title: "Easy Aerobic Swim", time: "30-40 min", detail: "No drills today, just continuous easy swimming focused on the lesson cue and staying relaxed. If you have to stop every 25y, that's fine — the goal is time in the water, not distance." },
      { d: "rest", title: "Rest", time: "—", detail: "Full rest ahead of the weekend." },
    ]},
    { day: "Sat 8/22", sessions: [
      { d: "bike", title: "Long Ride", time: "2:00", detail: "Z2 endurance, flat-to-rolling terrain. Fuel every 30-45 min. This anchors the week — keep it honest and easy." },
    ]},
    { day: "Sun 8/23", sessions: [
      { d: "run", title: "Long Run", time: "75 min", detail: "Z2 endurance. Slightly below your current long-run ceiling on purpose — this phase is about swim investment, not run progression." },
    ]},
  ],
};

const WEEK2 = {
  label: "Week 2", range: "Aug 24 – 30, 2026", note: "Same template. Second swim lesson if the coach has weekly availability — otherwise a self-directed session reinforcing week 1's cues.",
  days: [
    { day: "Mon 8/24", sessions: [
      { d: "swim", title: "Lesson or Guided Drill Session", time: "45 min", detail: "Continue technique work. If a second lesson isn't scheduled yet, run the same drill progression as last Wednesday and film a short clip if possible." },
      { d: "lift", title: "Strength — Push", time: "50 min", detail: "Same structure as week 1. Add weight only where last week's top set felt like RIR 3+." },
    ]},
    { day: "Tue 8/25", sessions: [
      { d: "run", title: "Easy Aerobic Run", time: "40-45 min", detail: "Z2, same as last week." },
      { d: "rest", title: "Mobility / Rest", time: "—", detail: "" },
    ]},
    { day: "Wed 8/26", sessions: [
      { d: "swim", title: "Technique + Light Aerobic", time: "45 min", detail: "Drill set (10×50y) followed by 4×100y easy continuous, holding technique cues under mild fatigue." },
      { d: "lift", title: "Strength — Pull", time: "50 min", detail: "" },
    ]},
    { day: "Thu 8/27", sessions: [
      { d: "bike", title: "Tempo Intervals (trainer)", time: "60 min", detail: "20 min warm-up, 3×9 min tempo, 3 min recovery between, 15 min cool-down." },
      { d: "lift", title: "Strength — Shoulders", time: "45 min", detail: "" },
    ]},
    { day: "Fri 8/28", sessions: [
      { d: "swim", title: "Easy Aerobic Swim", time: "35 min", detail: "Continuous, relaxed, technique-focused." },
      { d: "rest", title: "Rest", time: "—", detail: "" },
    ]},
    { day: "Sat 8/29", sessions: [
      { d: "bike", title: "Long Ride", time: "2:00-2:15", detail: "Z2 endurance, small bump from last week if legs felt fresh Sunday." },
    ]},
    { day: "Sun 8/30", sessions: [
      { d: "run", title: "Long Run", time: "80 min", detail: "Z2 endurance." },
    ]},
  ],
};

const WEEK3 = {
  label: "Week 3", range: "Aug 31 – Sep 6, 2026", note: "Third lesson/drill session. Benchmark week — baseline swim, bike, and run tests happen before the travel disruption so Phase 2 has real numbers to work from.",
  days: [
    { day: "Mon 8/31", sessions: [
      { d: "swim", title: "Lesson / Drill Reinforcement", time: "45 min", detail: "" },
      { d: "lift", title: "Strength — Push", time: "50 min", detail: "" },
    ]},
    { day: "Tue 9/1", sessions: [
      { d: "run", title: "Easy Aerobic Run", time: "40 min", detail: "Keep it easy — threshold test is Thursday." },
      { d: "rest", title: "Mobility / Rest", time: "—", detail: "" },
    ]},
    { day: "Wed 9/2", sessions: [
      { d: "swim", title: "400m Time Trial (Benchmark)", time: "40 min", detail: "Warm up 200y easy. Swim 400y/m at best sustainable effort, note total time and how many stops. This is your Phase 1 swim baseline — do not judge it harshly, it's a starting line, not a grade." },
      { d: "lift", title: "Strength — Pull", time: "50 min", detail: "" },
    ]},
    { day: "Thu 9/3", sessions: [
      { d: "run", title: "30-Min Threshold Test (Benchmark)", time: "45 min", detail: "15 min warm-up. 30 min at hardest sustainable steady effort — this sets your run threshold pace/HR for zone calculations. 10 min cool-down." },
      { d: "lift", title: "Strength — Shoulders", time: "45 min", detail: "" },
    ]},
    { day: "Fri 9/4", sessions: [
      { d: "swim", title: "Easy Aerobic Swim", time: "30 min", detail: "Recovery swim after Wednesday's test." },
      { d: "rest", title: "Rest", time: "—", detail: "" },
    ]},
    { day: "Sat 9/5", sessions: [
      { d: "bike", title: "FTP / 20-Min Field Test (Benchmark)", time: "2:00 total", detail: "20 min warm-up. 20 min all-out steady effort (power or best-effort pace if no power meter data yet). This sets bike training zones. Remainder of ride easy Z2 to round out 2 hours." },
    ]},
    { day: "Sun 9/6", sessions: [
      { d: "run", title: "Long Run", time: "80 min", detail: "Z2, easy — legs get a break after Saturday's harder ride." },
    ]},
  ],
};

const WEEK4 = {
  label: "Week 4", range: "Sep 7 – 13, 2026", note: "Pre-travel taper. Monday–Thursday hold normal structure at slightly reduced load, then Friday the Europe running-only block begins — see the Europe Block tab.",
  days: [
    { day: "Mon 9/7", sessions: [
      { d: "swim", title: "Technique Swim", time: "40 min", detail: "Normal drill/technique work, nothing new introduced this close to travel." },
      { d: "lift", title: "Strength — Push (lighter)", time: "40 min", detail: "Same exercises, drop one set each to start easing volume before 2+ weeks without a gym." },
    ]},
    { day: "Tue 9/8", sessions: [
      { d: "run", title: "Easy Aerobic Run", time: "40 min", detail: "Z2." },
      { d: "rest", title: "Mobility / Rest", time: "—", detail: "" },
    ]},
    { day: "Wed 9/9", sessions: [
      { d: "swim", title: "Easy Aerobic Swim", time: "35 min", detail: "Last pool session before the break — keep it light and technique-focused." },
      { d: "lift", title: "Strength — Pull (lighter)", time: "40 min", detail: "" },
    ]},
    { day: "Thu 9/10", sessions: [
      { d: "bike", title: "Easy Spin", time: "45 min", detail: "Last ride before the break. Pure Z2, no intervals — legs should feel fresh, not worked, heading into a run-only stretch." },
      { d: "lift", title: "Strength — Shoulders (lighter)", time: "35 min", detail: "Trim volume further. This is the last lift session until you're back." },
    ]},
    { day: "Fri 9/11", sessions: [
      { d: "travel", title: "Travel Day", time: "—", detail: "Departure. Light optional walk if schedule allows. No structured training." },
    ]},
    { day: "Sat 9/12", sessions: [
      { d: "run", title: "Easy Run", time: "30-35 min", detail: "First run of the Europe block — see Europe Block tab for the full template. Keep it short and easy while adjusting to travel and terrain." },
    ]},
    { day: "Sun 9/13", sessions: [
      { d: "run", title: "Easy Run", time: "35-40 min", detail: "Z2, continue the Europe block template." },
    ]},
  ],
};

const DETAIL_WEEKS = [WEEK1, WEEK2, WEEK3, WEEK4];

const EUROPE_TEMPLATE = [
  { day: "Mon", d: "run", title: "Easy Run", time: "30-40 min", detail: "Z2, flat if terrain allows. First run in a new place — treat pace as secondary to just getting a feel for the ground." },
  { day: "Tue", d: "run", title: "Steady Run + Strides", time: "40-45 min", detail: "Z2 body of the run, then 4-6×20s relaxed strides at the end to keep some leg turnover without hard training stress." },
  { day: "Wed", d: "rest", title: "Rest / Optional Bodyweight Circuit", time: "0-15 min", detail: "Full rest, or an optional 15-min bodyweight circuit: push-ups, planks, single-leg glute bridges, band work if you packed one. Not mandatory — this block is about the legs and consistency, not squeezing in extra strength work." },
  { day: "Thu", d: "run", title: "Steady Run + Strides", time: "40-45 min", detail: "Same as Tuesday." },
  { day: "Fri", d: "run", title: "Easy Run", time: "30-40 min", detail: "Z2, easy." },
  { day: "Sat", d: "run", title: "Longer Run", time: "60-70 min", detail: "Deliberately capped shorter than your normal Sunday long run at home — this is about maintaining durability, not building it, with zero swim/bike to balance the load against." },
  { day: "Sun", d: "rest", title: "Rest / Optional Bodyweight Circuit", time: "0-15 min", detail: "Full rest, or the optional circuit from Wednesday." },
];

const RETURN_WEEKS = [
  { label: "Week 7 — Sep 28-Oct 4", title: "Re-Entry", items: [
    "Swim: 2× easy technique-reset sessions, 30 min (~800 yd) each — just re-establishing feel for the water.",
    "Bike: 1× easy spin, 45 min (~10 mi) + 1 shortened long ride, 90 min (~23 mi, pure Z2).",
    "Run: hold at Europe-block volume (~3.5 mi easy day, ~6 mi long run), don't add anything yet. One full rest day.",
    "Strength: restart at 2×/week, roughly 60% of pre-travel volume (drop a set or two per exercise).",
  ]},
  { label: "Week 8 — Oct 5-11", title: "Building Back", items: [
    "Swim: 3×/week, technique-focused (~1000 yd/session), building toward continuous 200-300y sets.",
    "Bike: 2×/week — 1 easy spin (~11 mi) + 1 long ride back to 1:45 (~27 mi).",
    "Run: normal Phase 1 volume resumes (~4.5 mi easy days, ~7.5 mi long run).",
    "Strength: 3×/week, light-to-moderate load.",
  ]},
  { label: "Week 9 — Oct 12-18", title: "Near Full Restore", items: [
    "Swim: 3×/week technique + early endurance sets, ~1100 yd/session.",
    "Bike: long ride back to 2:00 (~31 mi).",
    "Strength: full Push/Pull/Shoulders volume restored.",
  ]},
  { label: "Week 10 — Oct 19-25", title: "Full Template + Retest", items: [
    "Full Phase 1 weekly template restored (see Week 1-3 structure).",
    "Swim frequency steps up to 4×/week heading into Phase 2.",
    "End-of-week benchmark retest: 400m swim time trial, bike 20-min field test (~32 mi total ride), run 30-min threshold test (~3.5 mi) — these set your Phase 2 training zones.",
  ]},
];

const STRENGTH_DAYS = [
  { name: "Push", color: COLORS.swim, exercises: [
    ["Bench or DB Press", "4×6-8", "RIR 2"],
    ["Incline DB Press", "3×8-10", "RIR 2"],
    ["Overhead Triceps Extension", "3×10-12", "RIR 2"],
    ["Cable or Band Fly", "2×12-15", "RIR 2"],
  ]},
  { name: "Pull", color: COLORS.bike, exercises: [
    ["Pull-Ups or Lat Pulldown", "4×6-8", "RIR 2"],
    ["DB or Barbell Row", "3×8-10", "RIR 2"],
    ["Face Pulls", "3×12-15", "shoulder health"],
    ["Bicep Curl", "2×10-12", "RIR 2"],
  ]},
  { name: "Shoulders", color: COLORS.run, exercises: [
    ["Standing Overhead Press", "4×6-8", "RIR 2"],
    ["Lateral Raise", "3×12-15", "RIR 2"],
    ["Rear Delt Fly", "3×12-15", "RIR 2"],
    ["Band External Rotation", "3×15", "light, rotator cuff"],
    ["Bulgarian Split Squat", "3×8/leg", "posterior chain + single leg"],
    ["Plank", "3×45s", "core"],
  ]},
];

const BENCHMARKS = [
  { week: "Week 3 (Sep 2-6)", tests: "Swim 400m TT · Run 30-min threshold · Bike 20-min field test", note: "Baseline for all three disciplines, done deliberately before the Europe disruption." },
  { week: "Week 10 (Oct 19-25)", tests: "Full retest — same three tests", note: "Sets Phase 2 training zones. First real look at swim progress after 10 weeks of technique work." },
  { week: "Week 19 (end of Phase 2)", tests: "Full retest + first brick-adjacent effort", note: "Confirms zones before race-specific work begins." },
  { week: "Week 26 — Feb 14 (Austin Half Marathon)", tests: "13.1 mi race effort", note: "The best real-world fitness check in the whole plan — a genuine race, not a simulation. Short taper before, easy rebound after." },
  { week: "Week 27 (end of Phase 3)", tests: "Full retest", note: "Zone check right after the half marathon, before Peak begins." },
  { week: "Week 31 (end of Peak)", tests: "Light retest only", note: "No hard testing here — protect freshness heading into taper." },
];

const ADAPT_LEVELS = [
  { n: 1, title: "No Change", color: COLORS.run, desc: "One workout runs a bit hot or cold but the overall trend is healthy. Plan stays exactly as written." },
  { n: 2, title: "Small Adjustment", color: COLORS.swim, desc: "A limited but real trend shows up. Pace/power targets, interval length, or weekly volume get a modest nudge for the next few sessions." },
  { n: 3, title: "Deload / Recovery", color: COLORS.bike, desc: "Multiple signals point to excess fatigue. Volume and intensity both drop, recovery gets prioritized, key adaptations get protected." },
  { n: 4, title: "Plan Reassessment", color: "#C4574A", desc: "Injury, illness, major missed block, or a persistent trend either direction. The longer-term plan itself gets revisited, not just the next few days." },
];

// ---------- calendar data ----------
// Compact tuples: [discipline, title, time]
const CAL = {
  "2026-08-15": [["bike", "Group Ride — Completed", "1:41", "26.2 mi"]],
  "2026-08-16": [["run", "Long Run — Zone 2", "1:15-1:20", "8.0 mi"]],
  "2026-08-17": [["swim","First Stroke Assessment (Lesson)","45 min"],["lift","Strength — Push","50 min"]],
  "2026-08-18": [["run","Easy Aerobic Run","40 min"],["rest","Mobility / Rest","—"]],
  "2026-08-19": [["swim","Technique Drills","45 min"],["lift","Strength — Pull","50 min"]],
  "2026-08-20": [["bike","Tempo Intervals (trainer)","60 min"],["lift","Strength — Shoulders","45 min"]],
  "2026-08-21": [["swim","Easy Aerobic Swim","30-40 min"],["rest","Rest","—"]],
  "2026-08-22": [["bike","Long Ride","2:00"]],
  "2026-08-23": [["run","Long Run","75 min"]],
  "2026-08-24": [["swim","Lesson or Guided Drill Session","45 min"],["lift","Strength — Push","50 min"]],
  "2026-08-25": [["run","Easy Aerobic Run","40-45 min"],["rest","Mobility / Rest","—"]],
  "2026-08-26": [["swim","Technique + Light Aerobic","45 min"],["lift","Strength — Pull","50 min"]],
  "2026-08-27": [["bike","Tempo Intervals (trainer)","60 min"],["lift","Strength — Shoulders","45 min"]],
  "2026-08-28": [["swim","Easy Aerobic Swim","35 min"],["rest","Rest","—"]],
  "2026-08-29": [["bike","Long Ride","2:00-2:15"]],
  "2026-08-30": [["run","Long Run","80 min"]],
  "2026-08-31": [["swim","Lesson / Drill Reinforcement","45 min"],["lift","Strength — Push","50 min"]],
  "2026-09-01": [["run","Easy Aerobic Run","40 min"],["rest","Mobility / Rest","—"]],
  "2026-09-02": [["swim","400m Time Trial (Benchmark)","40 min"],["lift","Strength — Pull","50 min"]],
  "2026-09-03": [["run","30-Min Threshold Test (Benchmark)","45 min"],["lift","Strength — Shoulders","45 min"]],
  "2026-09-04": [["swim","Easy Aerobic Swim","30 min"],["rest","Rest","—"]],
  "2026-09-05": [["bike","FTP / 20-Min Field Test (Benchmark)","2:00"]],
  "2026-09-06": [["run","Long Run","80 min"]],
  "2026-09-07": [["swim","Technique Swim","40 min"],["lift","Strength — Push (lighter)","40 min"]],
  "2026-09-08": [["run","Easy Aerobic Run","40 min"],["rest","Mobility / Rest","—"]],
  "2026-09-09": [["swim","Easy Aerobic Swim","35 min"],["lift","Strength — Pull (lighter)","40 min"]],
  "2026-09-10": [["bike","Easy Spin","45 min"],["lift","Strength — Shoulders (lighter)","35 min"]],
  "2026-09-11": [["travel","Travel Day","—"]],
  "2026-09-12": [["run","Easy Run","30-35 min"]],
  "2026-09-13": [["run","Easy Run","35-40 min"]],
  "2026-09-14": [["run","Easy Run","30-40 min"]],
  "2026-09-15": [["run","Steady Run + Strides","40-45 min"]],
  "2026-09-16": [["rest","Rest / Optional Bodyweight Circuit","0-15 min"]],
  "2026-09-17": [["run","Steady Run + Strides","40-45 min"]],
  "2026-09-18": [["run","Easy Run","30-40 min"]],
  "2026-09-19": [["run","Longer Run","60-70 min"]],
  "2026-09-20": [["rest","Rest / Optional Bodyweight Circuit","0-15 min"]],
  "2026-09-21": [["run","Easy Run","30-40 min"]],
  "2026-09-22": [["run","Steady Run + Strides","40-45 min"]],
  "2026-09-23": [["rest","Rest / Optional Bodyweight Circuit","0-15 min"]],
  "2026-09-24": [["run","Steady Run + Strides","40-45 min"]],
  "2026-09-25": [["run","Easy Run","30-40 min"]],
  "2026-09-26": [["run","Longer Run","60-70 min"]],
  "2026-09-27": [["travel","Return Travel Day","—"]],
  "2026-09-28": [["rest","Rest — Travel Recovery","—"]],
  "2026-09-29": [["run","Easy Run","35 min"],["lift","Strength — Push (reduced)","35 min"]],
  "2026-09-30": [["swim","Easy Technique Reset","30 min"]],
  "2026-10-01": [["bike","Easy Spin","45 min"],["lift","Strength — Pull (reduced)","35 min"]],
  "2026-10-02": [["swim","Easy Technique Reset","30 min"]],
  "2026-10-03": [["bike","Shortened Long Ride","1:30"]],
  "2026-10-04": [["run","Long Run (reduced)","60 min"]],
  "2026-10-05": [["swim","Technique + Early Endurance","40 min"],["lift","Strength — Push (moderate)","45 min"]],
  "2026-10-06": [["run","Easy Run","45 min"]],
  "2026-10-07": [["swim","Technique Swim","40 min"],["lift","Strength — Pull (moderate)","45 min"]],
  "2026-10-08": [["bike","Easy / Tempo-Lite","45 min"],["lift","Strength — Shoulders (moderate)","40 min"]],
  "2026-10-09": [["swim","Easy Aerobic Swim","35 min"]],
  "2026-10-10": [["bike","Long Ride","1:45"]],
  "2026-10-11": [["run","Long Run","75 min"]],
  "2026-10-12": [["swim","Technique + Endurance","45 min"],["lift","Strength — Push","50 min"]],
  "2026-10-13": [["run","Easy Run","45 min"]],
  "2026-10-14": [["swim","Technique + Endurance","45 min"],["lift","Strength — Pull","50 min"]],
  "2026-10-15": [["bike","Tempo Intervals (trainer)","60 min"],["lift","Strength — Shoulders","45 min"]],
  "2026-10-16": [["swim","Easy Aerobic Swim","35 min"]],
  "2026-10-17": [["bike","Long Ride","2:00"]],
  "2026-10-18": [["run","Long Run","80 min"]],
  "2026-10-19": [["swim","Technique Swim","45 min"],["lift","Strength — Push","50 min"]],
  "2026-10-20": [["run","Easy Run","40 min"],["swim","Easy Recovery Swim","30 min"]],
  "2026-10-21": [["swim","400m Time Trial (Benchmark)","40 min"],["lift","Strength — Pull","50 min"]],
  "2026-10-22": [["run","30-Min Threshold Test (Benchmark)","45 min"],["lift","Strength — Shoulders","45 min"]],
  "2026-10-23": [["swim","Easy Recovery Swim","30 min"]],
  "2026-10-24": [["bike","FTP / 20-Min Field Test (Benchmark)","2:00"]],
  "2026-10-25": [["run","Long Run","80 min"]],
  "2027-02-12": [["run", "Shakeout Run", "20 min"]],
  "2027-02-13": [["rest", "Rest — Pre-Race", "—"]],
  "2027-02-14": [["run", "Austin Half Marathon (Race)", "1:45-2:15", "13.1 mi"]],
  "2027-02-15": [["rest", "Recovery — Rest", "—"]],
};

const PHASE_RANGES = [
  { start: "2026-08-17", end: "2026-10-25", n: 1, color: COLORS.swim },
  { start: "2026-10-26", end: "2026-12-27", n: 2, color: COLORS.bike },
  { start: "2026-12-28", end: "2027-02-21", n: 3, color: COLORS.run },
  { start: "2027-02-22", end: "2027-03-21", n: 4, color: COLORS.lift },
  { start: "2027-03-22", end: "2027-04-11", n: 5, color: "#C4574A" },
];

// Full 34-week volume progression. Weeks 1-10 are real sums from the detailed daily
// plan above; weeks 11-34 are a generated periodized model (4:1 build/cutback pattern)
// anchored to the actual Week 10 numbers — not detailed day-by-day yet, refined as each
// phase approaches, same as weeks 1-10 were.
const WEEK_META = [
  { week: 1, start: "2026-08-17", run: 12.4, bike: 48.5, swimYd: 4388, tag: "" },
  { week: 2, start: "2026-08-24", run: 13.2, bike: 50.4, swimYd: 4388, tag: "" },
  { week: 3, start: "2026-08-31", run: 19.1, bike: 32.0, swimYd: 3025, tag: "benchmark" },
  { week: 4, start: "2026-09-07", run: 11.8, bike: 10.5, swimYd: 2975, tag: "" },
  { week: 5, start: "2026-09-14", run: 25.1, bike: 0, swimYd: 0, tag: "europe" },
  { week: 6, start: "2026-09-21", run: 25.1, bike: 0, swimYd: 0, tag: "europe" },
  { week: 7, start: "2026-09-28", run: 10.2, bike: 33.8, swimYd: 2100, tag: "" },
  { week: 8, start: "2026-10-05", run: 12.9, bike: 38.4, swimYd: 4375, tag: "" },
  { week: 9, start: "2026-10-12", run: 13.4, bike: 48.5, swimYd: 4725, tag: "" },
  { week: 10, start: "2026-10-19", run: 19.1, bike: 32.0, swimYd: 4562, tag: "benchmark" },
  { week: 11, start: "2026-10-26", run: 20.5, bike: 40, swimYd: 5000, tag: "" },
  { week: 12, start: "2026-11-02", run: 21.5, bike: 48, swimYd: 5400, tag: "" },
  { week: 13, start: "2026-11-09", run: 23, bike: 56, swimYd: 5800, tag: "" },
  { week: 14, start: "2026-11-16", run: 17, bike: 38, swimYd: 4200, tag: "cutback" },
  { week: 15, start: "2026-11-23", run: 24, bike: 62, swimYd: 6000, tag: "" },
  { week: 16, start: "2026-11-30", run: 25, bike: 68, swimYd: 6200, tag: "" },
  { week: 17, start: "2026-12-07", run: 26.5, bike: 74, swimYd: 6400, tag: "" },
  { week: 18, start: "2026-12-14", run: 19, bike: 50, swimYd: 4800, tag: "cutback" },
  { week: 19, start: "2026-12-21", run: 26, bike: 85, swimYd: 6500, tag: "benchmark" },
  { week: 20, start: "2026-12-28", run: 27, bike: 88, swimYd: 6600, tag: "" },
  { week: 21, start: "2027-01-04", run: 28, bike: 92, swimYd: 6800, tag: "" },
  { week: 22, start: "2027-01-11", run: 22, bike: 70, swimYd: 5200, tag: "cutback" },
  { week: 23, start: "2027-01-18", run: 30, bike: 98, swimYd: 7000, tag: "" },
  { week: 24, start: "2027-01-25", run: 32, bike: 104, swimYd: 7300, tag: "" },
  { week: 25, start: "2027-02-01", run: 29, bike: 85, swimYd: 6800, tag: "" },
  { week: 26, start: "2027-02-08", run: 23, bike: 55, swimYd: 3800, tag: "half-marathon" },
  { week: 27, start: "2027-02-15", run: 22, bike: 95, swimYd: 7200, tag: "benchmark" },
  { week: 28, start: "2027-02-22", run: 30, bike: 140, swimYd: 7500, tag: "" },
  { week: 29, start: "2027-03-01", run: 33, bike: 160, swimYd: 8000, tag: "" },
  { week: 30, start: "2027-03-08", run: 36, bike: 185, swimYd: 8800, tag: "peak" },
  { week: 31, start: "2027-03-15", run: 28, bike: 120, swimYd: 6500, tag: "benchmark" },
  { week: 32, start: "2027-03-22", run: 20, bike: 70, swimYd: 4500, tag: "" },
  { week: 33, start: "2027-03-29", run: 12, bike: 40, swimYd: 2500, tag: "" },
  { week: 34, start: "2027-04-05", run: 5, bike: 15, swimYd: 1500, tag: "race-week" },
];
const HALF_MARATHON_DATE = "2027-02-14";
function fmtLabel(dateStr) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function dstr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function phaseForDate(key) {
  return PHASE_RANGES.find((p) => key >= p.start && key <= p.end);
}
const TODAY_KEY = "2026-08-15";
const PLAN_START_KEY = "2026-08-15";
const PLAN_END_DETAIL_KEY = "2026-10-25";

// ---------- UI pieces ----------
function DayCard({ day }) {
  return (
    <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: "16px 18px", marginBottom: 12 }}>
      <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: COLORS.muted, marginBottom: 10, letterSpacing: 1 }}>{day.day.toUpperCase()}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {day.sessions.map((s, i) => {
          const m = disciplineMeta[s.d];
          return (
            <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ width: 3, alignSelf: "stretch", background: m.color, borderRadius: 2, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                  <Pill discipline={s.d}>{m.label}</Pill>
                  <span style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 16, color: COLORS.text }}>{s.title}</span>
                  {s.time !== "—" && <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12.5, color: COLORS.muted }}>{s.time}</span>}
                  {estimateDistance(s.d, s.title, s.time) && (
                    <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12.5, color: m.color, background: m.color + "16", padding: "1px 8px", borderRadius: 999 }}>
                      {estimateDistance(s.d, s.title, s.time)}
                    </span>
                  )}
                </div>
                {s.detail && <div style={{ color: COLORS.muted, fontSize: 13.5, lineHeight: 1.55 }}>{s.detail}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OverviewTab({ today, raceDate }) {
  const daysToRace = Math.round((raceDate - today) / 86400000);
  const weeksToRace = Math.floor(daysToRace / 7);
  return (
    <div>
      <div style={{
        background: `linear-gradient(135deg, ${COLORS.surface} 0%, ${COLORS.surface2} 100%)`,
        border: `1px solid ${COLORS.line}`, borderRadius: 14, padding: "28px 30px", marginBottom: 36,
        display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 20,
      }}>
        <div>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: COLORS.muted, letterSpacing: 2, marginBottom: 6 }}>RACE COUNTDOWN</div>
          <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 42, color: COLORS.text, lineHeight: 1 }}>
            {daysToRace} <span style={{ fontSize: 18, color: COLORS.muted, fontWeight: 500 }}>days</span>
          </div>
          <div style={{ color: COLORS.muted, fontSize: 13.5, marginTop: 4 }}>~{weeksToRace} weeks · target mid-April 2027 (exact date TBD)</div>
        </div>
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: COLORS.muted, letterSpacing: 1.5 }}>CURRENT PHASE</div>
            <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 18, color: COLORS.swim }}>Phase 1 — Foundation</div>
          </div>
          <div>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: COLORS.muted, letterSpacing: 1.5 }}>PRIORITY</div>
            <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 18, color: COLORS.text }}>Swim technique</div>
          </div>
        </div>
      </div>

      <SectionHeading eyebrow="34-Week Periodization" title="Full Plan Overview" sub="Five phases from today through race week. Weekly structure holds Saturday for the long bike and Sunday for the long run throughout, with swimming as the priority investment early on." />

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {PHASES.map((p) => (
          <div key={p.n} style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderLeft: `4px solid ${p.color}`, borderRadius: 10, padding: "18px 22px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontFamily: "JetBrains Mono, monospace", color: p.color, fontSize: 13, fontWeight: 700 }}>PHASE {p.n}</span>
                <span style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 20, color: COLORS.text }}>{p.name}</span>
              </div>
              <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12.5, color: COLORS.muted }}>{p.weeks} · {p.range}</span>
            </div>
            <div style={{ color: COLORS.muted, fontSize: 14, lineHeight: 1.6 }}>{p.desc}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 36, background: COLORS.surface2, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: "20px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Target size={16} color={COLORS.bike} />
          <span style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 16, color: COLORS.text }}>Where you're starting from</span>
        </div>
        <div style={{ color: COLORS.muted, fontSize: 14, lineHeight: 1.7 }}>
          Running is a genuine strength — consistent volume and solid cadence already. Cycling has good aerobic durability on long rides, though cadence discipline needs work. Swimming is the real gap: about four sessions logged in the last four months, pace around 1:50-2:15/100m, and no formal technique background. Phase 1 is built around fixing that with real lessons, not just more yardage.
        </div>
      </div>

      <div style={{ marginTop: 20, background: COLORS.surface2, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: "20px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <TrendingUp size={16} color={COLORS.swim} />
          <span style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 16, color: COLORS.text }}>Your zones (pulled from Strava, not guessed)</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 12 }}>
          <div>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11.5, color: COLORS.run, letterSpacing: 1, marginBottom: 8 }}>HEART RATE</div>
            {ZONES.hr.map((z) => (
              <div key={z.n} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0", color: COLORS.text }}>
                <span style={{ color: COLORS.muted }}>Z{z.n} {z.label}</span><span style={{ fontFamily: "JetBrains Mono, monospace" }}>{z.range}</span>
              </div>
            ))}
          </div>
          <div>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11.5, color: COLORS.bike, letterSpacing: 1, marginBottom: 8 }}>POWER · FTP {ZONES.ftp}W{ZONES.ftpEstimated ? " (est.)" : ""}</div>
            {ZONES.power.map((z) => (
              <div key={z.n} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0", color: COLORS.text }}>
                <span style={{ color: COLORS.muted }}>Z{z.n} {z.label}</span><span style={{ fontFamily: "JetBrains Mono, monospace" }}>{z.range}</span>
              </div>
            ))}
          </div>
          <div>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11.5, color: COLORS.swim, letterSpacing: 1, marginBottom: 8 }}>RUN PACE</div>
            {ZONES.run.map((z) => (
              <div key={z.n} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0", color: COLORS.text }}>
                <span style={{ color: COLORS.muted }}>Z{z.n} {z.label}</span><span style={{ fontFamily: "JetBrains Mono, monospace" }}>{z.range}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ color: COLORS.muted, fontSize: 12.5, lineHeight: 1.6, borderTop: `1px solid ${COLORS.line}`, paddingTop: 12 }}>{ZONES.note}</div>
      </div>
    </div>
  );
}

function WeeksTab() {
  const [active, setActive] = useState(0);
  return (
    <div>
      <SectionHeading eyebrow="Deliverable" title="First 4 Weeks — Full Detail" sub="Every session, every day, fully actionable. Week 4 transitions straight into the Europe travel block." />
      <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
        {DETAIL_WEEKS.map((w, i) => (
          <button key={i} onClick={() => setActive(i)} style={{
            fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 14, padding: "9px 18px", borderRadius: 8, cursor: "pointer",
            background: active === i ? COLORS.swim : COLORS.surface, color: active === i ? "#08131C" : COLORS.text,
            border: `1px solid ${active === i ? COLORS.swim : COLORS.line}`,
          }}>{w.label}</button>
        ))}
      </div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.text }}>{DETAIL_WEEKS[active].label} <span style={{ color: COLORS.muted, fontWeight: 400, fontSize: 16 }}>· {DETAIL_WEEKS[active].range}</span></div>
        <div style={{ color: COLORS.muted, fontSize: 13.5, marginTop: 6, lineHeight: 1.6, maxWidth: 640 }}>{DETAIL_WEEKS[active].note}</div>
      </div>
      {DETAIL_WEEKS[active].days.map((d, i) => <DayCard key={i} day={d} />)}
    </div>
  );
}

function EuropeTab() {
  return (
    <div>
      <SectionHeading eyebrow="Sep 11 – 26, 2026 · 16 days" title="Europe Block — Running Only" sub="No swim, no bike, no gym required. The goal is maintaining aerobic fitness and running durability without inviting injury from a sudden jump in run-only volume." />
      <div style={{ background: COLORS.surface2, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: "18px 22px", marginBottom: 28 }}>
        <div style={{ color: COLORS.muted, fontSize: 14, lineHeight: 1.7 }}>
          This isn't an attempt to replace lost bike and swim hours with extra running — that trade is a fast way to get hurt. Instead this block holds moderate, mostly-easy running with one longer effort each week, deliberately capped shorter than the usual Sunday long run since there's nothing to balance the load against. Repeat this weekly template across both weeks in Europe, shifting days as travel logistics require.
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {EUROPE_TEMPLATE.map((d, i) => {
          const dist = estimateDistance(d.d, d.title, d.time);
          const m = disciplineMeta[d.d];
          return (
            <div key={i} style={{ display: "flex", gap: 16, alignItems: "flex-start", background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: "14px 18px" }}>
              <div style={{ width: 52, flexShrink: 0, fontFamily: "JetBrains Mono, monospace", fontSize: 12.5, color: COLORS.muted, paddingTop: 3 }}>{d.day.toUpperCase()}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3, flexWrap: "wrap" }}>
                  <Pill discipline={d.d}>{m.label}</Pill>
                  <span style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 16, color: COLORS.text }}>{d.title}</span>
                  <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: COLORS.muted }}>{d.time}</span>
                  {dist && <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: m.color, background: m.color + "16", padding: "1px 8px", borderRadius: 999 }}>{dist}</span>}
                </div>
                <div style={{ color: COLORS.muted, fontSize: 13.5, lineHeight: 1.55 }}>{d.detail}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReturnTab() {
  return (
    <div>
      <SectionHeading eyebrow="Sep 28 – Oct 25, 2026" title="Return-to-Training" sub="A deliberate four-week re-entry rather than jumping straight back into full Phase 1 volume — swimming in particular gets rebuilt gradually rather than resumed at full frequency." />
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {RETURN_WEEKS.map((w, i) => (
          <div key={i} style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: "18px 22px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12.5, color: COLORS.bike }}>{w.label}</span>
              <span style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 18, color: COLORS.text }}>{w.title}</span>
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, color: COLORS.muted, fontSize: 14, lineHeight: 1.8 }}>
              {w.items.map((it, j) => <li key={j}>{it}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function StrengthTab() {
  return (
    <div>
      <SectionHeading eyebrow="3×/week · Push / Pull / Shoulders" title="Strength Program" sub="Built to support Ironman training, not compete with it — enough volume to keep building, positioned so leg fatigue never bleeds into Saturday's long ride or Sunday's long run." />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 28 }}>
        {STRENGTH_DAYS.map((d, i) => (
          <div key={i} style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderTop: `3px solid ${d.color}`, borderRadius: 10, padding: "18px 20px" }}>
            <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 19, color: COLORS.text, marginBottom: 14 }}>{d.name}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {d.exercises.map((e, j) => (
                <div key={j} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13.5 }}>
                  <span style={{ color: COLORS.text }}>{e[0]}</span>
                  <span style={{ fontFamily: "JetBrains Mono, monospace", color: COLORS.muted, textAlign: "right", flexShrink: 0 }}>{e[1]}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ background: COLORS.surface2, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: "18px 22px" }}>
        <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 16, color: COLORS.text, marginBottom: 8 }}>Progression & periodization</div>
        <div style={{ color: COLORS.muted, fontSize: 14, lineHeight: 1.75 }}>
          Add weight when the top of a rep range is hit at RIR 2 for two sessions in a row. Deload every fifth week — drop one set per exercise, hold intensity. During Peak (weeks 28-31), volume drops to 2×/week with 2-3 exercises per session, roughly 40% less total volume, to protect the highest-stress endurance weeks. Taper (weeks 32-34) drops to 1×/week light maintenance, then stops entirely race week.
        </div>
      </div>
    </div>
  );
}

function BenchTab() {
  return (
    <div>
      <SectionHeading eyebrow="Testing Calendar" title="Benchmarks" sub="Periodic, not constant — enough to update training zones with real data, not so often that testing itself becomes a training-stress problem." />
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 40 }}>
        {BENCHMARKS.map((b, i) => (
          <div key={i} style={{ display: "flex", gap: 18, alignItems: "flex-start", background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: "16px 20px" }}>
            <TrendingUp size={18} color={COLORS.bike} style={{ marginTop: 3, flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 15.5, color: COLORS.text }}>{b.week}</div>
              <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12.5, color: COLORS.swim, margin: "4px 0" }}>{b.tests}</div>
              <div style={{ color: COLORS.muted, fontSize: 13.5, lineHeight: 1.5 }}>{b.note}</div>
            </div>
          </div>
        ))}
      </div>

      <SectionHeading eyebrow="How the plan adapts" title="Adaptation Logic" sub="One good or bad workout never rewrites the plan. Changes require sustained evidence, escalating through four levels." />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
        {ADAPT_LEVELS.map((l) => (
          <div key={l.n} style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderTop: `3px solid ${l.color}`, borderRadius: 10, padding: "16px 18px" }}>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: l.color, marginBottom: 4 }}>LEVEL {l.n}</div>
            <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 16, color: COLORS.text, marginBottom: 8 }}>{l.title}</div>
            <div style={{ color: COLORS.muted, fontSize: 13, lineHeight: 1.55 }}>{l.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DaySessionRow({ dateKey, sess, idx, completion, onToggle }) {
  const m = disciplineMeta[sess[0]];
  const Icon = m.icon;
  const done = !!completion[`${dateKey}::${idx}`];
  const dist = estimateDistance(sess[0], sess[1], sess[2], sess[3]);
  return (
    <div onClick={() => onToggle(dateKey, idx)} style={{
      display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 8, cursor: "pointer",
      background: done ? m.color + "14" : COLORS.surface, border: `1px solid ${done ? m.color + "55" : COLORS.line}`,
    }}>
      {done ? <CheckCircle2 size={19} color={m.color} style={{ flexShrink: 0 }} /> : <Circle size={19} color={COLORS.muted} style={{ flexShrink: 0 }} />}
      <Icon size={15} color={m.color} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 14.5, color: COLORS.text, textDecoration: done ? "line-through" : "none", opacity: done ? 0.7 : 1 }}>{sess[1]}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {sess[2] !== "—" && <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: COLORS.muted }}>{sess[2]}</span>}
        {dist && <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11.5, color: m.color, background: m.color + "16", padding: "1px 7px", borderRadius: 999, whiteSpace: "nowrap" }}>{dist}</span>}
      </div>
    </div>
  );
}

function CalendarTab({ completion, onToggle }) {
  const [monthIdx, setMonthIdx] = useState(0); // 0 = Aug 2026
  const [selected, setSelected] = useState(TODAY_KEY);

  const months = useMemo(() => {
    const arr = [];
    let d = new Date(2026, 7, 1); // Aug 2026
    for (let i = 0; i < 9; i++) {
      arr.push(new Date(d));
      d.setMonth(d.getMonth() + 1);
    }
    return arr;
  }, []);

  const monthDate = months[monthIdx];
  const monthLabel = monthDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const grid = useMemo(() => {
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const firstOfMonth = new Date(year, month, 1);
    // Monday-start offset
    const startOffset = (firstOfMonth.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [monthDate]);

  const selectedSessions = CAL[selected] || null;
  const selectedPhase = phaseForDate(selected);
  const selectedIsPast = selected < TODAY_KEY;
  const selectedInDetailRange = selected >= PLAN_START_KEY && selected <= PLAN_END_DETAIL_KEY;

  return (
    <div>
      <SectionHeading eyebrow="Day by day" title="Calendar" sub="Tap a day to see the sessions, tap a session to check it off. Detail runs through week 10 (Oct 25) — later months show the phase you'll be in until that stretch gets planned in full closer to the date." />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <button onClick={() => setMonthIdx((i) => Math.max(0, i - 1))} disabled={monthIdx === 0} style={{
          background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 8, cursor: monthIdx === 0 ? "default" : "pointer", opacity: monthIdx === 0 ? 0.35 : 1, color: COLORS.text,
        }}><ChevronLeft size={18} /></button>
        <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 22, color: COLORS.text, letterSpacing: 0.5 }}>{monthLabel}</div>
        <button onClick={() => setMonthIdx((i) => Math.min(months.length - 1, i + 1))} disabled={monthIdx === months.length - 1} style={{
          background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 8, cursor: monthIdx === months.length - 1 ? "default" : "pointer", opacity: monthIdx === months.length - 1 ? 0.35 : 1, color: COLORS.text,
        }}><ChevronRight size={18} /></button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5, marginBottom: 6 }}>
        {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => (
          <div key={d} style={{ textAlign: "center", fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: COLORS.muted, letterSpacing: 1, paddingBottom: 4 }}>{d.toUpperCase()}</div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5, marginBottom: 26 }}>
        {grid.map((date, i) => {
          if (!date) return <div key={i} />;
          const key = dstr(date);
          const sessions = CAL[key];
          const phase = phaseForDate(key);
          const isToday = key === TODAY_KEY;
          const isSelected = key === selected;
          const isPast = key < TODAY_KEY;
          const total = sessions ? sessions.length : 0;
          const doneCount = sessions ? sessions.filter((_, idx) => completion[`${key}::${idx}`]).length : 0;
          const allDone = total > 0 && doneCount === total;
          return (
            <button key={i} onClick={() => setSelected(key)} style={{
              aspectRatio: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
              borderRadius: 9, cursor: "pointer", position: "relative", padding: 4,
              background: isSelected ? COLORS.surface2 : COLORS.surface,
              border: isToday ? `1.5px solid ${COLORS.bike}` : `1px solid ${isSelected ? COLORS.line : "transparent"}`,
              opacity: isPast && !allDone && total > 0 ? 0.55 : 1,
            }}>
              <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12.5, color: isToday ? COLORS.bike : COLORS.text, fontWeight: isToday ? 700 : 500 }}>{date.getDate()}</span>
              {total > 0 ? (
                <div style={{ display: "flex", gap: 3 }}>
                  {sessions.map((s, idx) => {
                    const m = disciplineMeta[s[0]];
                    const sDone = !!completion[`${key}::${idx}`];
                    return <span key={idx} style={{ width: 5, height: 5, borderRadius: "50%", background: m.color, opacity: sDone ? 1 : 0.4, boxShadow: sDone ? `0 0 0 1.5px ${m.color}55` : "none" }} />;
                  })}
                </div>
              ) : phase ? (
                <span style={{ width: 14, height: 2, borderRadius: 2, background: phase.color, opacity: 0.35 }} />
              ) : null}
              {allDone && <CheckCircle2 size={11} color={COLORS.run} style={{ position: "absolute", top: 3, right: 3 }} />}
            </button>
          );
        })}
      </div>

      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 12, padding: "20px 22px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 18, color: COLORS.text }}>
            {new Date(selected + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            {selected === TODAY_KEY && <span style={{ color: COLORS.bike, fontSize: 12, fontFamily: "JetBrains Mono, monospace", marginLeft: 10 }}>TODAY</span>}
          </div>
          {selectedPhase && <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11.5, color: selectedPhase.color, letterSpacing: 1 }}>PHASE {selectedPhase.n}</span>}
        </div>

        {selectedSessions ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {selectedSessions.map((s, idx) => (
              <DaySessionRow key={idx} dateKey={selected} sess={s} idx={idx} completion={completion} onToggle={onToggle} />
            ))}
          </div>
        ) : selectedInDetailRange ? (
          <div style={{ color: COLORS.muted, fontSize: 14 }}>Rest day — nothing scheduled.</div>
        ) : (
          <div style={{ color: COLORS.muted, fontSize: 14, lineHeight: 1.6 }}>
            Not planned day-by-day yet. This falls in Phase {selectedPhase ? selectedPhase.n : "?"} — daily detail gets added as this stretch approaches, same as weeks 1–10 were.
          </div>
        )}
      </div>
    </div>
  );
}

function sessionMiles(sess) {
  const [d, title, time, override] = sess;
  if (d !== "run" && d !== "bike") return 0;
  if (override) {
    const m = override.match(/([\d.]+)\s*mi/);
    if (m) return parseFloat(m[1]);
  }
  const raw = estimateDistanceRaw(d, title, time);
  return raw && raw.unit === "mi" ? raw.value : 0;
}
function sessionYards(sess) {
  const [d, title, time] = sess;
  if (d !== "swim") return 0;
  if ((title || "").toLowerCase().includes("400m")) return 437;
  const raw = estimateDistanceRaw(d, title, time);
  return raw && raw.unit === "yd" ? raw.value : 0;
}
function weekStartOf(dateKey) {
  const d = new Date(dateKey + "T00:00:00");
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return dstr(d);
}

function ProgressionTooltip({ active, payload, label, unit }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0];
  const meta = WEEK_META.find((w) => fmtLabel(w.start) === label);
  return (
    <div style={{ background: COLORS.surface2, border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: "10px 14px", fontSize: 12.5 }}>
      <div style={{ color: COLORS.muted, fontFamily: "JetBrains Mono, monospace", marginBottom: 3 }}>{meta ? `Week ${meta.week} · ${label}` : label}</div>
      <div style={{ color: p.color, fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 15 }}>{p.value} {unit}</div>
      {meta && meta.tag === "cutback" && <div style={{ color: COLORS.muted, marginTop: 3 }}>Recovery / cutback week</div>}
      {meta && meta.tag === "europe" && <div style={{ color: COLORS.muted, marginTop: 3 }}>Europe block — running only</div>}
      {meta && meta.tag === "half-marathon" && <div style={{ color: COLORS.run, marginTop: 3 }}>Austin Half Marathon week</div>}
      {meta && meta.tag === "peak" && <div style={{ color: COLORS.lift, marginTop: 3 }}>Peak week of the plan</div>}
      {meta && meta.tag === "benchmark" && <div style={{ color: COLORS.swim, marginTop: 3 }}>Benchmark testing week</div>}
      {meta && meta.tag === "race-week" && <div style={{ color: "#C4574A", marginTop: 3 }}>Ironman race week</div>}
    </div>
  );
}

function ProgressionChart({ title, dataKey, color, unit, showHalfMarathon }) {
  const data = useMemo(() => WEEK_META.map((w) => ({ ...w, label: fmtLabel(w.start) })), []);
  const europeStart = fmtLabel("2026-09-14");
  const europeEnd = fmtLabel("2026-09-21");
  const raceWeekLabel = fmtLabel("2027-04-05");
  const halfMarathonWeek = WEEK_META.find((w) => w.tag === "half-marathon");
  const gradId = `grad-${dataKey}`;

  return (
    <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 12, padding: "20px 22px 12px", marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14, flexWrap: "wrap", gap: 6 }}>
        <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 17, color: COLORS.text }}>{title}</div>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11.5, color: COLORS.muted }}>34 weeks · Aug 2026 → Apr 2027</div>
      </div>
      <div style={{ width: "100%", height: 200 }}>
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 6, right: 10, left: -18, bottom: 4 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.45} />
                <stop offset="100%" stopColor={color} stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.line} vertical={false} />
            <XAxis dataKey="label" stroke={COLORS.muted} fontSize={10.5} tickLine={false} axisLine={{ stroke: COLORS.line }} interval={2} />
            <YAxis stroke={COLORS.muted} fontSize={11} tickLine={false} axisLine={false} unit={unit === "yd" ? "" : unit} />
            <Tooltip content={<ProgressionTooltip unit={unit} />} />
            <ReferenceArea x1={europeStart} x2={europeEnd} fill={COLORS.muted} fillOpacity={0.08} />
            <ReferenceLine x={raceWeekLabel} stroke="#C4574A" strokeDasharray="4 3" label={{ value: "Race", position: "insideTopRight", fill: "#C4574A", fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" }} />
            {showHalfMarathon && halfMarathonWeek && (
              <ReferenceDot x={fmtLabel(halfMarathonWeek.start)} y={halfMarathonWeek[dataKey]} r={5} fill={COLORS.run} stroke={COLORS.bg} strokeWidth={2} label={{ value: "Half Marathon", position: "top", fill: COLORS.run, fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" }} />
            )}
            <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2.5} fill={`url(#${gradId})`} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ProgressTab({ completion }) {
  const weekly = useMemo(() => {
    const map = {};
    Object.keys(CAL).sort().forEach((key) => {
      const wk = weekStartOf(key);
      if (!map[wk]) map[wk] = { week: wk, run: 0, bike: 0, swimYd: 0, sessions: 0 };
      CAL[key].forEach((sess) => {
        map[wk].run += sessionMiles(sess) * (sess[0] === "run" ? 1 : 0);
        map[wk].bike += sessionMiles(sess) * (sess[0] === "bike" ? 1 : 0);
        map[wk].swimYd += sessionYards(sess);
        map[wk].sessions += 1;
      });
    });
    return Object.values(map).sort((a, b) => a.week.localeCompare(b.week));
  }, []);

  const chartData = weekly.map((w) => ({
    label: new Date(w.week + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    Run: Math.round(w.run * 10) / 10,
    Bike: Math.round(w.bike * 10) / 10,
  }));
  const swimChartData = weekly.map((w) => ({
    label: new Date(w.week + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    "Swim (yd)": Math.round(w.swimYd),
  }));

  const thisWeekKey = weekStartOf(TODAY_KEY);
  const thisWeek = weekly.find((w) => w.week === thisWeekKey);
  let doneCount = 0, totalCount = 0;
  Object.keys(CAL).forEach((key) => {
    if (weekStartOf(key) !== thisWeekKey) return;
    CAL[key].forEach((_, idx) => {
      totalCount += 1;
      if (completion[`${key}::${idx}`]) doneCount += 1;
    });
  });

  return (
    <div>
      <SectionHeading eyebrow="Full Plan · 34 Weeks" title="Progress" sub="Weekly mileage progression for all three disciplines from today through race day, including the Austin Half Marathon and the taper. Weeks 1-10 are real numbers from the detailed daily plan; weeks 11-34 are a periodized model that gets refined into daily detail as each phase approaches." />

      <ProgressionChart title="Run — Weekly Mileage" dataKey="run" color={COLORS.run} unit="mi" showHalfMarathon />
      <ProgressionChart title="Bike — Weekly Mileage" dataKey="bike" color={COLORS.bike} unit="mi" />
      <ProgressionChart title="Swim — Weekly Yardage" dataKey="swimYd" color={COLORS.swim} unit="yd" />

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 36, fontSize: 12, color: COLORS.muted }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS.run, display: "inline-block" }} /> Austin Half Marathon — Feb 14</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, background: COLORS.muted, opacity: 0.3, display: "inline-block" }} /> Europe block — no bike/swim</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 2, background: "#C4574A", display: "inline-block" }} /> Ironman race week</span>
      </div>

      <SectionHeading eyebrow="Near-Term Detail" title="This Week &amp; Recent Weeks" sub="The granular view — actual planned sessions for weeks 1-10, with live completion tracking." />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 32 }}>
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderTop: `3px solid ${COLORS.run}`, borderRadius: 10, padding: "16px 18px" }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: COLORS.muted, letterSpacing: 1 }}>THIS WEEK · RUN</div>
          <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 26, color: COLORS.text }}>{thisWeek ? thisWeek.run.toFixed(1) : "0"} <span style={{ fontSize: 14, color: COLORS.muted }}>mi</span></div>
        </div>
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderTop: `3px solid ${COLORS.bike}`, borderRadius: 10, padding: "16px 18px" }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: COLORS.muted, letterSpacing: 1 }}>THIS WEEK · BIKE</div>
          <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 26, color: COLORS.text }}>{thisWeek ? thisWeek.bike.toFixed(1) : "0"} <span style={{ fontSize: 14, color: COLORS.muted }}>mi</span></div>
        </div>
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderTop: `3px solid ${COLORS.swim}`, borderRadius: 10, padding: "16px 18px" }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: COLORS.muted, letterSpacing: 1 }}>THIS WEEK · SWIM</div>
          <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 26, color: COLORS.text }}>{thisWeek ? Math.round(thisWeek.swimYd) : "0"} <span style={{ fontSize: 14, color: COLORS.muted }}>yd</span></div>
        </div>
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderTop: `3px solid ${COLORS.lift}`, borderRadius: 10, padding: "16px 18px" }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: COLORS.muted, letterSpacing: 1 }}>THIS WEEK · DONE</div>
          <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 26, color: COLORS.text }}>{doneCount}<span style={{ fontSize: 16, color: COLORS.muted }}>/{totalCount}</span></div>
        </div>
      </div>

      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 12, padding: "20px 22px", marginBottom: 20 }}>
        <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 15, color: COLORS.text, marginBottom: 14 }}>Run &amp; Bike Volume — Weeks 1-10 Detail</div>
        <div style={{ width: "100%", height: 260 }}>
          <ResponsiveContainer>
            <BarChart data={chartData} margin={{ top: 4, right: 8, left: -18, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.line} vertical={false} />
              <XAxis dataKey="label" stroke={COLORS.muted} fontSize={11} tickLine={false} axisLine={{ stroke: COLORS.line }} interval={1} />
              <YAxis stroke={COLORS.muted} fontSize={11} tickLine={false} axisLine={false} unit="mi" />
              <Tooltip contentStyle={{ background: COLORS.surface2, border: `1px solid ${COLORS.line}`, borderRadius: 8, fontSize: 12.5 }} labelStyle={{ color: COLORS.text }} />
              <Legend wrapperStyle={{ fontSize: 12.5 }} />
              <Bar dataKey="Run" fill={COLORS.run} radius={[3, 3, 0, 0]} />
              <Bar dataKey="Bike" fill={COLORS.bike} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 12, padding: "20px 22px" }}>
        <div style={{ fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 15, color: COLORS.text, marginBottom: 14 }}>Swim Volume — Weeks 1-10 Detail</div>
        <div style={{ width: "100%", height: 220 }}>
          <ResponsiveContainer>
            <BarChart data={swimChartData} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.line} vertical={false} />
              <XAxis dataKey="label" stroke={COLORS.muted} fontSize={11} tickLine={false} axisLine={{ stroke: COLORS.line }} interval={1} />
              <YAxis stroke={COLORS.muted} fontSize={11} tickLine={false} axisLine={false} unit="yd" />
              <Tooltip contentStyle={{ background: COLORS.surface2, border: `1px solid ${COLORS.line}`, borderRadius: 8, fontSize: 12.5 }} labelStyle={{ color: COLORS.text }} />
              <Bar dataKey="Swim (yd)" fill={COLORS.swim} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ---------- main ----------
export default function App() {
  const [tab, setTab] = useState("overview");
  const today = useMemo(() => new Date(2026, 7, 15), []);
  const raceDate = useMemo(() => new Date(2027, 3, 11), []);
  const [completion, setCompletion] = useState(() => loadCompletion());

  useEffect(() => {
    saveCompletion(completion);
  }, [completion]);

  const toggleSession = useCallback((dateKey, idx) => {
    const k = `${dateKey}::${idx}`;
    setCompletion((prev) => ({ ...prev, [k]: !prev[k] }));
  }, []);

  const tabs = [
    { id: "overview", label: "Overview", icon: Target },
    { id: "calendar", label: "Calendar", icon: LayoutGrid },
    { id: "progress", label: "Progress", icon: BarChart3 },
    { id: "weeks", label: "First 4 Weeks", icon: Footprints },
    { id: "europe", label: "Europe Block", icon: Plane },
    { id: "return", label: "Return", icon: RotateCcw },
    { id: "strength", label: "Strength", icon: Dumbbell },
    { id: "bench", label: "Benchmarks", icon: TrendingUp },
  ];

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", color: COLORS.text, fontFamily: "system-ui, sans-serif" }}>
      <style>{FONT_IMPORT}</style>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "40px 24px 100px" }}>
        <div style={{ marginBottom: 36 }}>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: COLORS.bike, letterSpacing: 3, marginBottom: 6 }}>IRONMAN · APRIL 2027</div>
          <h1 style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 40, margin: 0, letterSpacing: 0.5 }}>Training Plan</h1>
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 36, flexWrap: "wrap", borderBottom: `1px solid ${COLORS.line}`, paddingBottom: 14 }}>
          {tabs.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                display: "flex", alignItems: "center", gap: 7,
                fontFamily: "Oswald, sans-serif", fontWeight: 600, fontSize: 13.5, letterSpacing: 0.3,
                padding: "9px 15px", borderRadius: 7, cursor: "pointer", textTransform: "uppercase",
                background: isActive ? COLORS.surface2 : "transparent",
                color: isActive ? COLORS.text : COLORS.muted,
                border: `1px solid ${isActive ? COLORS.line : "transparent"}`,
              }}>
                <Icon size={14} /> {t.label}
              </button>
            );
          })}
        </div>

        {tab === "overview" && <OverviewTab today={today} raceDate={raceDate} />}
        {tab === "calendar" && <CalendarTab completion={completion} onToggle={toggleSession} />}
        {tab === "progress" && <ProgressTab completion={completion} />}
        {tab === "weeks" && <WeeksTab />}
        {tab === "europe" && <EuropeTab />}
        {tab === "return" && <ReturnTab />}
        {tab === "strength" && <StrengthTab />}
        {tab === "bench" && <BenchTab />}
      </div>
    </div>
  );
}

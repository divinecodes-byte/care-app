// Lightweight design-token layer — Tavora Week 2 product-polish task #5
// (visual-system consistency, layout responsiveness, interaction polish).
//
// This does NOT replace constants/theme.ts — RADIUS/SPACING/SHADOW/T/T_DARK
// still own colors and the existing radius/shadow scale (many screens
// already depend on them correctly). This file adds the missing semantic
// layer Phase 1's audit found absent: every screen was hand-picking its own
// padding/heading-size/spacer numbers instead of sharing one source, which
// is exactly how e.g. four different "screen top padding" values (12/24/32/40)
// and four different "heading font size" values (28/30/34/40) ended up
// across eight structurally-similar auth/onboarding screens with no
// evident reason for any of the differences.
//
// Values below were chosen by convergence, not invention: each is the
// value already used by a plurality of existing screens for that role
// (see docs/visual-design-model.md for the audit this was built from),
// so adopting these tokens moves outlier screens toward the app's own
// existing center of gravity rather than introducing a new, unrelated look.

import { RADIUS } from '@/constants/theme';

// ─── Spacing scale ──────────────────────────────────────────────────────────
// General-purpose scale for one-off gaps/margins. For the specific named
// roles (screen padding, section gap, card gap) prefer LAYOUT below —
// this scale is for everything else (icon-to-label gaps, chip gaps, etc.)
// that doesn't have its own named role.

export const SPACING_SCALE = {
    xs:  4,
    sm:  8,
    md:  12,
    lg:  16,
    xl:  20,
    xxl: 24,
} as const;

// ─── Radii (semantic aliases over the existing RADIUS scale) ───────────────
// No new radius values — every one of these already exists in RADIUS and is
// already the plurality choice for its role; this just gives each role a
// name so a screen reaches for "the button radius" instead of guessing
// which RADIUS.* happens to match whatever a nearby screen used.

export const RADII = {
    input:  RADIUS.lg,   // 16 — every text input across signin/signup/forgot/reset/reminder forms
    button: RADIUS.xl,   // 20 — every primary button across the whole app
    card:   RADIUS.xl,   // 20 — the option-card / content-card family (choose-use-case, choose-role, reminder cards)
    sheet:  RADIUS.xxl,  // 28 — bottom-sheet tops (settings sheet, TimePickerField, index.tsx's CTA sheet)
    pill:   RADIUS.full, // status badges, chips
} as const;

// ─── Typography hierarchy ───────────────────────────────────────────────────
// Concrete per-role style objects — spread directly into a StyleSheet entry,
// e.g. `heading: { ...TYPOGRAPHY.screenTitle, color: C.textPrimary }`.
// Font sizes converge auth/onboarding screens' 28/30/34/40 spread down to
// two roles: `hero` (the one true landing screen, index.tsx) and
// `screenTitle` (every subsequent form/onboarding screen).

export const TYPOGRAPHY = {
    hero: {
        fontSize: 40,
        fontWeight: '800' as const,
        lineHeight: 48,
        letterSpacing: -1,
    },
    screenTitle: {
        fontSize: 30,
        fontWeight: '800' as const,
        lineHeight: 37,
        letterSpacing: -0.6,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '800' as const,
        lineHeight: 23,
        letterSpacing: -0.3,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: '700' as const,
        lineHeight: 21,
    },
    body: {
        fontSize: 16,
        fontWeight: '400' as const,
        lineHeight: 24,
        letterSpacing: -0.1,
    },
    secondaryBody: {
        fontSize: 14,
        fontWeight: '500' as const,
        lineHeight: 20,
    },
    caption: {
        fontSize: 13,
        fontWeight: '500' as const,
        lineHeight: 18,
    },
    buttonLabel: {
        fontSize: 17,
        fontWeight: '700' as const,
    },
    destructiveLabel: {
        fontSize: 15,
        fontWeight: '700' as const,
    },
    numericMetric: {
        fontSize: 32,
        fontWeight: '800' as const,
        letterSpacing: -0.5,
    },
} as const;

// ─── Layout ──────────────────────────────────────────────────────────────
// The named roles Phase 1's matrix found scattered across 3-4 different
// raw numbers each with no evident reason for the differences.

export const LAYOUT = {
    // Screen edge-to-content padding. 24 is already what a majority of
    // screens use (signin/signup/forgot-password/reset-password/
    // choose-use-case/choose-role); index.tsx's hero (28) and
    // notification-permission.tsx (28) are the two outliers moved to 24.
    screenPaddingHorizontal: 24,
    // Vertical gap between clearly separate sections on the same screen
    // (e.g. header block -> form block, or card -> card).
    sectionGap: 24,
    // Gap between stacked cards within the same section/list.
    cardGap: 12,
    // On a tablet-width viewport, centered content stops growing past this
    // — never a separate tablet layout, just a reading-width cap so a
    // reminder form doesn't stretch into an unreadably wide single column.
    maxContentWidth: 560,
    // Every interactive control's minimum tap target — matches
    // components/AccessiblePrimitives.tsx's MIN_TOUCH (kept as one
    // source: that file imports this constant rather than redefining it).
    minControlHeight: 44,
} as const;

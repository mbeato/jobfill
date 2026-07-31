# ATS & Resume-Tailoring Research (2026-07-23)

Salvaged synthesis from a deep-research run (5 search angles → 15 sources → claim
extraction → partial adversarial verification; run stopped early for cost). Confidence
tiers: **VERIFIED** = survived 3-vote adversarial verification; **CORROBORATED** =
asserted independently by 3+ unrelated sources, not adversarially verified;
**REFUTED** = killed in verification (listed because the refutations matter).

Consumer: the `/tailor` pipeline (select/reorder-only, LaTeX single-column, pdflatex)
for new-grad SWE applications to US startups via Greenhouse, Lever, Ashby, Workday.

## 1. Do these platforms even rank resumes?

- **CORROBORATED (5+ independent sources):** Greenhouse, Lever, and Ashby do NOT
  algorithmically score, rank, or auto-reject resumes by default. Candidate lists sort
  by application date/pipeline stage. Every Greenhouse rejection is a manual human
  action against a structured scorecard. Recruiters *retrieve* candidates via keyword
  search and filters over parsed fields. (atsverification.com 2026; jobscan Greenhouse
  guide 2026; hiration; index.dev comparison; recruiter accounts.)
- **CORROBORATED:** The only genuine automation is employer-configured **knockout
  questions** on the application form — wrong answer → auto-disposition. Resume
  content plays no part in that.
- **VERIFIED (high confidence):** Workday is the exception when the employer licenses
  **HiredScore** (Workday-owned since 2024): resumes get algorithmic A–D grades
  against the requisition's weighted requirements (HiredScore's own docs; TIAA's
  NYC LL144 bias audit treats it as an Automated Employment Decision Tool). Grades
  drive recruiter attention order.
- **REFUTED:** "Workday has no auto-rejection capability." Killed twice in
  verification: Workday supports knockout auto-disposition, and *Mobley v. Workday*
  (N.D. Cal., conditionally certified as an ADEA collective action May 2025) alleges
  algorithmic rejection at scale. Safe statement: HiredScore grades prioritize human
  review; employer-configured screens can auto-disposition.
- **Implication for jobfill:** for Greenhouse/Lever/Ashby (the fill allowlist), the
  optimization target is (a) recruiter keyword-search retrieval and (b) the human
  skim — there is no ranking algorithm to beat. Workday (manual fills only) is the
  one place algorithmic grading is real.

## 2. Keyword strategy

- **CORROBORATED:** Matching is literal or lightly stemmed in recruiter search — use
  the JD's exact vocabulary ("TypeScript" not "JavaScript frameworks"; their phrasing
  of "CI/CD"). Related-but-distinct terms are not equivalent ("observability" ≠
  "monitoring").
- **CORROBORATED:** Spell out + acronym on first use ("Infrastructure as Code (IaC)")
  — you can't know which form the recruiter searches. Skills sections are parsed and
  load-bearing for filtering; order skills to mirror the JD's own ordering.
- **CORROBORATED:** Keyword *stuffing* does nothing algorithmically on these
  platforms and reads as spam to humans. VERIFIED (medium): the Ladders study found
  keyword stuffing characterized the worst-rated resumes in human review.
- **CORROBORATED:** No published "safe match percentage" exists; third-party ATS
  match scores (Jobscan-style) are invented consumer metrics recruiters never see.
- **CORROBORATED:** ~8% of recruiters configure any content-based auto-rejection
  (hr.com 2025 report via two independent write-ups); >90% of applications get at
  least brief human review.

## 3. PDF / LaTeX parsing

- **CORROBORATED:** The failure modes are specific: multi-column layouts (parsers
  read content-stream order straight across), icons/graphics-as-text, ligature/
  encoding problems without ToUnicode maps, and contact info in headers/footers
  (~25% of parsers miss it, per Jobscan). Single-column article-class templates
  (Jake's-Resume-style, which our own resume template follows) parse cleanly on
  all four target platforms; pdflatex preferred over XeLaTeX/LuaLaTeX.
- **Template audit against this:** ours already passes — single column,
  `\input{glyphtounicode}` + `\pdfgentounicode=1` (ligature/ToUnicode handled),
  no header/footer contact info, no graphics. Greenhouse hard limit: 2.5MB (ours ~120KB).
- **CORROBORATED:** Parsing still matters even with no auto-rejection — a scrambled
  parse makes the resume invisible to recruiter keyword search. Cheap eval proxy:
  copy-paste the PDF into plain text and check section/keyword survival (OpenResume's
  open-source parser is a runnable harness for this — Phase 13 eval candidate).

## 4. Human-skim facts (the actual gate on Greenhouse/Lever/Ashby)

- **VERIFIED (medium, directional):** Initial recruiter screens are a fast skim
  (~7.4s in Ladders' 2018 eye-tracking study, n≈30, vendor study — treat as
  directional, not precise). Deeper reads happen only after the first-pass
  pattern-match passes.
- **VERIFIED (medium):** Top-rated resumes in that study: simple layouts, clear
  section headers, bold titles, bulleted accomplishments (F/E-pattern reading).
  Cite as directional; the study is small and non-peer-reviewed.
- **REFUTED (overreach):** "Multi-column layouts *measurably* hurt attention" and
  "job titles get more time than any other element" — both overreach the study
  (confounded bundles, unsupported superlative). Single-column stands on parsing
  grounds regardless.
- **CORROBORATED:** Short stints: label contract work "(Contract)" in the title
  (reads as project-based, not a quick exit); month–year date precision is the
  convention; bundling multiple short gigs under one umbrella entry is accepted.
- **CORROBORATED (secondary):** Application *timing* matters more than folklore
  admits — ~52% of recruiters review in arrival order; entry-level roles draw
  400–600+ applicants. (Supports the pipeline's 2-day-freshness principle.)

## 5. Myth list (with origins)

| Myth | Verdict | Evidence |
|---|---|---|
| "ATS auto-rejects 75% of resumes" | FALSE | Traced to a 2012 Preptel sales pitch; company died 2013; no methodology ever published. |
| "Beat the ATS score" on Greenhouse/Lever/Ashby | FALSE | No native content score exists; rejections are human. |
| White-text keyword stuffing | BACKFIRES | Parsers surface hidden text in plain view; some systems flag it. |
| Keyword repetition improves ranking | FALSE | No ranking to improve; spam signal to humans. |
| "Resumes never seen by humans" | FALSE | >90% get at least brief human review; knockouts are the only auto-reject. |
| "6-second scan" as a hard rule | MISLEADING | ~7.4s directional mean skewed by instant rejects; survivors get real reads. |

## 6. Rules adopted into the tailor prompt

1. Exact-vocabulary mirroring of true skills (already shipped 2026-07-23).
2. Spell-out + acronym on first use for JD-named technologies.
3. Skills ordering mirrors the JD's ordering.
4. No keyword beyond what base+pool substantiate (unchanged hard rule).
5. Optimize for recruiter search retrieval + 7-second skim, not a mythical score:
   JD-relevant bullet first under each entry, bold-title/bullet structure preserved.
6. Titles are facts; contract work carries "(Contract)"; month–year dates.

*Verification caveat: items marked CORROBORATED did not complete adversarial
verification before the run was stopped; they rest on 3+ independent sources each.*

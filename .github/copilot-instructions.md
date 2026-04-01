# Polarity Productions - AI Coding Instructions

## Project Context
This is a single, static HTML landing page for "Polarity Productions" - a personal production hub for music, tools, tutorials, and experiments. The site acts as a curated feature overview, not a complete archive.

## Tech Stack & Constraints
- **Core**: HTML5, Vanilla CSS, Vanilla JavaScript.
- **Backend**: PHP & MySQL (only if strictly necessary).
- **Frameworks**: NONE. Do not use React, Vue, Bootstrap, Tailwind, etc.
- **Rendering**: Server-side or static HTML only. No client-side rendering for content.

## Architecture & Structure
- **Single Page**: The main output is a simple, readable, static HTML structure.
- **Content Strategy**: Content is directly embedded in HTML.
- **Key Sections**:
  1. **Hero**: "Polarity Productions", subtitle, primary links (YouTube, Blog, Dispenser, Bandcamp, Patreon).
  2. **Featured Sections**: Grouped by theme (Tutorials, Music, Presets, Tools, Writing). Not chronological.
  3. **Footer**: Minimal links.

## Code Style & Conventions
- **CSS**:
  - Use CSS variables (`--color-bg`, `--spacing-md`) for all theming.
  - Design Mobile-First.
  - Default to Dark Mode friendly.
  - Keep layout minimal and typography strong.
- **HTML**:
  - Use semantic tags (`<header>`, `<main>`, `<section>`, `<footer>`).
  - Ensure Accessibility: ARIA roles, alt texts, keyboard navigation.
- **JavaScript**:
  - Use for interaction only, not content rendering.
  - Keep it vanilla and well-commented.

## Design & Tone
- **Visuals**: "Digital Workshop" feel. Creator-driven, not corporate.
- **Tone**: Personal, calm, confident, practical. Avoid sales language or buzzwords.
- **Performance**: Minimize load times, optimize images.

## Workflow
- **Build**: No build step required. Files should be ready to serve.
- **Testing**: Verify cross-browser compatibility and responsiveness manually.

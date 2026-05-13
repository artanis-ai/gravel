package wizard

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/artanis-ai/gravel/cli/internal/manifest"
)

// scan_review.go implements the Mallet-style scan + verify flow from
// the TS wizard: run the fast scan, walk the user through each finding
// (`Keep this one?`), then loop "Did I find everything?" with options
// to delegate to a local agent, add files manually, or call it done.
//
// Mirrors packages/sdk-ts/src/wizard/index.ts §runScanAndVerify.

// RunScanAndVerify executes the full scan + verify flow and returns
// the manifest that should be written to disk (caller writes it).
// Returns nil if the scan itself failed; surface the error to the
// user via the bullet logged here.
//
// `skipDeepScan` (driven by --no-deep-scan or non-TTY runs) shortcuts
// the loop — the wizard writes whatever the fast scan turned up and
// exits the step, since there's no human to drive the menu.
func RunScanAndVerify(
	ctx context.Context,
	cwd string,
	p Prompter,
	skipDeepScan bool,
) (*manifest.Manifest, error) {
	scanSp := NewSpinner("Scanning repo for prompts…")
	current, err := manifest.Read(cwd)
	if err != nil {
		scanSp.Fail(fmt.Sprintf("Couldn't read manifest: %s", err))
		return nil, err
	}
	res, err := manifest.FastScan(cwd, current)
	if err != nil {
		scanSp.Fail(fmt.Sprintf("Scan failed: %s", err))
		return nil, err
	}
	m := res.Manifest
	scanSp.Stop(fmt.Sprintf("Found %d prompt(s)", len(m.Prompts)))

	// Per-entry accept/deny on whatever fast-scan turned up.
	findings := append([]manifest.Prompt(nil), m.Prompts...)
	m.Prompts = m.Prompts[:0]
	if len(findings) > 0 {
		Say("Let me walk through each one:")
		for i, f := range findings {
			if reviewPrompt(cwd, f, i+1, len(findings), p) {
				m.Prompts = append(m.Prompts, f)
			}
		}
		sort.Slice(m.Prompts, func(i, j int) bool {
			return m.Prompts[i].Path < m.Prompts[j].Path
		})
	}

	// "Did I find everything?" loop. Non-interactive runs skip it.
	if !skipDeepScan {
		for {
			question := "Did I find everything?"
			defaultAns := true
			if len(m.Prompts) == 0 {
				question = "I haven't found any prompts. Want to add some manually or run a deeper search?"
				defaultAns = true // yes-default in interactive; non-interactive falls through
			}
			done, err := p.YesNo(question, defaultAns)
			if err != nil || done {
				break
			}

			agents := DetectAgents()
			menu, label := agentMenuLabel(agents)
			Say("OK, here are your options:")
			if label != "" {
				Bullet(Bold("a")+": Delegate the search to "+label+". It'll read your code (Read/Grep/Glob; nothing leaves the machine) and find prompts hidden in string literals or template strings. Slower but thorough.", BulletPlain)
			}
			Bullet(Bold("m")+": Add a file manually. You tell me the path (and optionally a line range); I add it to the manifest. Fastest if you already know where it is.", BulletPlain)
			Bullet(Bold("d")+": Done. Write what we have and move on.", BulletPlain)
			if label == "" {
				Note("(Want agent search? Install Claude Code (https://claude.com/code) or Codex (https://github.com/openai/codex) and re-run `gravel init`.)")
			}

			choice, err := p.Text("Choose "+Bold(menu)+":", "d")
			if err != nil {
				break
			}
			choice = strings.TrimSpace(strings.ToLower(choice))

			switch {
			case strings.HasPrefix(choice, "a") && label != "":
				before := len(m.Prompts)
				if updated, ok := runAgentSearchAndReview(ctx, cwd, p, m, agents); ok {
					m = updated
				}
				if len(m.Prompts) == before {
					// No new entries — loop again so the user can pick another option.
					continue
				}
			case strings.HasPrefix(choice, "m"):
				entry := addPromptInteractive(cwd, p)
				if entry != nil {
					m.Prompts = append(m.Prompts, *entry)
					sort.Slice(m.Prompts, func(i, j int) bool {
						return m.Prompts[i].Path < m.Prompts[j].Path
					})
					Bullet("Added "+formatPromptEntry(*entry), BulletOK)
				}
			default:
				// `d`, blank input, anything else — explicit done.
				break
			}
			if strings.HasPrefix(choice, "d") || (choice != "" && choice[0] != 'a' && choice[0] != 'm') {
				break
			}
		}
	}

	if err := manifest.Write(cwd, m); err != nil {
		return nil, err
	}
	Bullet(fmt.Sprintf("Manifest written: %d prompt(s) (%s)", len(m.Prompts), manifest.Path), BulletOK)
	return &m, nil
}

// reviewPrompt shows one prompt + a content snippet, then asks
// the user to keep or drop it. Defaults to keep — false positives are
// easier to ignore than a missed prompt is to recover.
func reviewPrompt(cwd string, pr manifest.Prompt, index, total int, p Prompter) bool {
	Say(fmt.Sprintf("%s %s", Brand(fmt.Sprintf("(%d/%d)", index, total)), formatPromptEntry(pr)))
	if preview := previewPrompt(cwd, pr); preview != "" {
		Note("     " + preview)
	}
	keep, err := p.YesNo("  Keep this one?", true)
	if err != nil {
		return true
	}
	return keep
}

// previewPrompt reads the file the prompt references and returns a
// short single-line excerpt (trimmed, whitespace-collapsed) for the
// user to recognise it.
func previewPrompt(cwd string, pr manifest.Prompt) string {
	abs := filepath.Join(cwd, filepath.FromSlash(pr.Path))
	body, err := os.ReadFile(abs)
	if err != nil {
		return ""
	}
	text := string(body)
	if pr.Type == manifest.PromptEmbedded && pr.CharStart != nil && pr.CharEnd != nil {
		cs, ce := *pr.CharStart, *pr.CharEnd
		if cs < 0 {
			cs = 0
		}
		if ce > len(text) {
			ce = len(text)
		}
		if cs < ce {
			text = text[cs:ce]
		}
	}
	collapsed := regexp.MustCompile(`\s+`).ReplaceAllString(strings.TrimSpace(text), " ")
	if len(collapsed) > 100 {
		collapsed = collapsed[:100] + "…"
	}
	return Dim(`"` + collapsed + `"`)
}

// formatPromptEntry renders a manifest entry as a one-line label
// for the per-entry review + loop output.
func formatPromptEntry(pr manifest.Prompt) string {
	if pr.Type == manifest.PromptEmbedded {
		tag := ""
		if pr.VarName != nil && *pr.VarName != "" {
			tag = " " + Dim("("+*pr.VarName+")")
		}
		ls, le := 0, 0
		if pr.LineStart != nil {
			ls = *pr.LineStart
		}
		if pr.LineEnd != nil {
			le = *pr.LineEnd
		}
		return fmt.Sprintf("%s%s %s", Bold(pr.Path), tag, Dim(fmt.Sprintf("@ L%d-%d", ls, le)))
	}
	return Bold(pr.Path)
}

// agentMenuLabel returns the menu shape ("[a/m/d]" or "[m/d]") and a
// human-readable label naming the available agent(s). Empty label
// means the user has neither claude nor codex on PATH — we suppress
// the `a` option from the menu in that case.
func agentMenuLabel(av AgentAvailability) (menu, label string) {
	switch {
	case av.Claude && av.Codex:
		return "[a/m/d]", "your local " + Bold("Claude Code") + " or " + Bold("Codex") + " (both detected on your PATH; you'll pick one)"
	case av.Claude:
		return "[a/m/d]", "your local " + Bold("Claude Code") + " (detected on your PATH)"
	case av.Codex:
		return "[a/m/d]", "your local " + Bold("Codex") + " (detected on your PATH)"
	}
	return "[m/d]", ""
}

// --- manual prompt entry ---------------------------------------------------

// addPromptInteractive walks the user through a single file +
// (optional) line/char range, validates everything, and returns the
// new manifest entry on success. Returns nil if the user cancelled
// or the inputs failed validation; the wizard loops back to the
// menu without writing anything.
func addPromptInteractive(cwd string, p Prompter) *manifest.Prompt {
	question := "File path " + Dim("(relative to repo root, Tab to complete)") + ":"
	var rawPath string
	var err error
	if canSpawnEditor(p) {
		// Real TTY + real prompter: drive a raw-mode line editor so Tab
		// completes filesystem paths. Ctrl-C cancels cleanly.
		rawPath, err = readPathWithCompletion(os.Stdin, os.Stderr, cwd, question)
		if errors.Is(err, ErrCancelled) {
			Bullet("Cancelled.", BulletSkip)
			return nil
		}
		if err != nil {
			// Raw mode failed (rare). Fall through to the plain prompt so
			// the user still gets a chance at the question.
			rawPath, err = p.Text(question, "")
		}
	} else {
		rawPath, err = p.Text(question, "")
	}
	if err != nil || strings.TrimSpace(rawPath) == "" {
		Bullet("No path given. Cancelled.", BulletSkip)
		return nil
	}
	rel := toRepoRelative(cwd, strings.TrimSpace(rawPath))
	abs := filepath.Join(cwd, filepath.FromSlash(rel))
	body, err := os.ReadFile(abs)
	if err != nil {
		Bullet("No such file: "+rel, BulletFail)
		return nil
	}
	text := string(body)

	whole, _ := p.YesNo("Is the whole file the prompt?", true)
	if whole {
		entry := manifest.Prompt{
			ID:   manifest.GeneratePromptID(rel, -1),
			Type: manifest.PromptFile,
			Path: rel,
			Hash: manifest.HashPrompt(text),
		}
		return &entry
	}

	// Pick between the two range-entry UXes based on prompter type:
	//   * Humans (ttyPrompter on a real TTY): spawn $EDITOR, let them
	//     "delete around" the prompt for interactive selection.
	//   * Everyone else (DefaultsPrompter, scripted test prompters,
	//     pipes): the old line/char number prompts. Scriptable and
	//     predictable for agent deep-scans and tests.
	//
	// Humans can still fall through to the line-number path by
	// cancelling out of the editor (the editor flow returns ok=false
	// on no-selection / no-change / non-substring edits).
	var ls, le, charStart, charEnd int
	if canSpawnEditor(p) {
		Say("OK, embedded prompt. Going to open it in your editor: " +
			"delete everything " + Bold("outside") + " the prompt you want to capture, " +
			"then save and exit.")
		_ = p.PressEnter("Press Enter to open the editor")
		picked, ok, err := editorPickSelection(text, rel)
		if err != nil {
			Bullet("Editor couldn't start: "+err.Error(), BulletFail)
			return nil
		}
		if ok {
			ls, le = picked.LineStart, picked.LineEnd
			charStart, charEnd = picked.CharStart, picked.CharEnd
			preview := text[charStart:charEnd]
			if len(preview) > 80 {
				preview = preview[:80] + "…"
			}
			Bullet(fmt.Sprintf("Captured L%d-%d %s", ls, le, Dim("("+strings.ReplaceAll(preview, "\n", " ")+")")), BulletOK)
		} else {
			Bullet("No actionable selection. Falling back to line-number entry.", BulletWarn)
			ls, le, charStart, charEnd = lineNumberFallback(text, p)
			if ls == 0 {
				return nil // line-number path also rejected
			}
		}
	} else {
		ls, le, charStart, charEnd = lineNumberFallback(text, p)
		if ls == 0 {
			return nil
		}
	}

	varName, _ := p.Text("Variable name "+Dim("(optional, Enter to skip)")+":", "")
	varName = strings.TrimSpace(varName)
	slice := text[charStart:charEnd]
	entry := manifest.Prompt{
		ID:        manifest.GeneratePromptID(fmt.Sprintf("%s:%d:%d:%s", rel, ls, le, varName), -1),
		Type:      manifest.PromptEmbedded,
		Path:      rel,
		Hash:      manifest.HashPrompt(slice),
		LineStart: &ls,
		LineEnd:   &le,
		CharStart: &charStart,
		CharEnd:   &charEnd,
	}
	if varName != "" {
		entry.VarName = &varName
	}
	return &entry
}

// lineNumberFallback is the original "type your line range" entry
// path. Used unconditionally for non-TTY callers (agents, --yes
// runs), and as a fallback for humans when the editor-pick flow
// declines.
//
// Returns (0, 0, 0, 0) on any validation failure — caller should
// treat that as "user cancelled, drop this entry".
func lineNumberFallback(text string, p Prompter) (lineStart, lineEnd, charStart, charEnd int) {
	startStr, _ := p.Text("Start line (1-indexed):", "")
	endStr, _ := p.Text("End line (inclusive):", "")
	ls, errA := strconv.Atoi(strings.TrimSpace(startStr))
	le, errB := strconv.Atoi(strings.TrimSpace(endStr))
	if errA != nil || errB != nil || ls < 1 || le < ls {
		Bullet(fmt.Sprintf("Invalid line range: %s-%s", startStr, endStr), BulletFail)
		return 0, 0, 0, 0
	}

	lineCharStart := manifest.LineToCharOffset(text, ls-1)
	lineCharEnd := manifest.LineToCharOffset(text, le)
	if lineCharStart < 0 || lineCharEnd <= lineCharStart {
		Bullet("Line range is past the end of the file", BulletFail)
		return 0, 0, 0, 0
	}
	cs, ce := lineCharStart, lineCharEnd

	override, _ := p.YesNo("Want to narrow it to a specific char range within those lines? "+Dim("(default: full lines)"), false)
	if override {
		csStr, _ := p.Text(fmt.Sprintf("Char start (offset into the file, >= %d):", lineCharStart), "")
		ceStr, _ := p.Text(fmt.Sprintf("Char end (<= %d):", lineCharEnd), "")
		csN, errCS := strconv.Atoi(strings.TrimSpace(csStr))
		ceN, errCE := strconv.Atoi(strings.TrimSpace(ceStr))
		if errCS == nil && errCE == nil && csN >= lineCharStart && ceN <= lineCharEnd && ceN > csN {
			cs, ce = csN, ceN
		} else {
			Bullet("Invalid char range; falling back to full lines", BulletWarn)
		}
	}
	return ls, le, cs, ce
}

// toRepoRelative converts an arbitrary user-typed path into one
// relative to cwd, using forward slashes. Absolute paths anywhere
// under cwd get rebased; paths outside cwd return as-given (let
// os.ReadFile error out cleanly downstream).
func toRepoRelative(cwd, raw string) string {
	if filepath.IsAbs(raw) {
		if rel, err := filepath.Rel(cwd, raw); err == nil && !strings.HasPrefix(rel, "..") {
			return filepath.ToSlash(rel)
		}
	}
	return filepath.ToSlash(filepath.Clean(raw))
}

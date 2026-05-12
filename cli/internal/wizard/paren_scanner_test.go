package wizard

import (
	"strings"
	"testing"
)

// paren_scanner_test.go pins matchClosingParen against the Python
// lexical edge cases that real customer projects throw at it. The
// scanner sits inside patchFastAPIMain; getting it wrong corrupts
// user source files, getting it overly conservative falls through to
// manual instructions.

func TestMatchClosingParen_SimpleBalanced(t *testing.T) {
	src := "FastAPI()"
	// `FastAPI(` starts at byte 7, the `(` is at 7.
	got := matchClosingParen(src, 7)
	if got != 8 {
		t.Errorf("balanced empty parens: got %d, want 8", got)
	}
}

func TestMatchClosingParen_NestedParens(t *testing.T) {
	src := `FastAPI(title=(get_title()))`
	openPos := strings.IndexByte(src, '(')
	got := matchClosingParen(src, openPos)
	if got != len(src)-1 {
		t.Errorf("nested parens: got %d, want %d", got, len(src)-1)
	}
}

func TestMatchClosingParen_MultiLine(t *testing.T) {
	src := `FastAPI(
    title="X",
    version="1.0",
)`
	openPos := strings.IndexByte(src, '(')
	got := matchClosingParen(src, openPos)
	if got != len(src)-1 {
		t.Errorf("multi-line: got %d, want %d", got, len(src)-1)
	}
}

func TestMatchClosingParen_StringWithEmbeddedParen(t *testing.T) {
	// Unbalanced `(` inside a string literal must NOT confuse the
	// counter; we still find the real closer at the end.
	src := `FastAPI(title="hello (world")`
	openPos := strings.IndexByte(src, '(')
	got := matchClosingParen(src, openPos)
	if got != len(src)-1 {
		t.Errorf("string with `(`: got %d, want %d", got, len(src)-1)
	}
}

func TestMatchClosingParen_SingleQuotedString(t *testing.T) {
	src := `FastAPI(title='hello)world')`
	openPos := strings.IndexByte(src, '(')
	got := matchClosingParen(src, openPos)
	if got != len(src)-1 {
		t.Errorf("single-quoted string with `)`: got %d, want %d", got, len(src)-1)
	}
}

func TestMatchClosingParen_FStringWithFunctionCall(t *testing.T) {
	// Python f-strings: `f"{settings.foo}"` and `f"v{int('1')+1}"`.
	src := `FastAPI(openapi_url=f"/v{int('1')+1}/openapi.json")`
	openPos := strings.IndexByte(src, '(')
	got := matchClosingParen(src, openPos)
	if got != len(src)-1 {
		t.Errorf("f-string with nested call: got %d, want %d", got, len(src)-1)
	}
}

func TestMatchClosingParen_TripleQuotedDocstring(t *testing.T) {
	src := `FastAPI(description="""multi-line
with ( unbalanced
parens inside """)`
	openPos := strings.IndexByte(src, '(')
	got := matchClosingParen(src, openPos)
	if got != len(src)-1 {
		t.Errorf("triple-quoted: got %d, want %d", got, len(src)-1)
	}
}

func TestMatchClosingParen_TripleQuotedSingle(t *testing.T) {
	src := `FastAPI(description='''contains (unbalanced''')`
	openPos := strings.IndexByte(src, '(')
	got := matchClosingParen(src, openPos)
	if got != len(src)-1 {
		t.Errorf("triple-single-quoted: got %d, want %d", got, len(src)-1)
	}
}

func TestMatchClosingParen_EscapedQuote(t *testing.T) {
	src := `FastAPI(title="he said \"hi)\" ok")`
	openPos := strings.IndexByte(src, '(')
	got := matchClosingParen(src, openPos)
	if got != len(src)-1 {
		t.Errorf("escaped quote: got %d, want %d", got, len(src)-1)
	}
}

func TestMatchClosingParen_HashCommentSkipped(t *testing.T) {
	// A `#`-comment inside a multi-line ctor must NOT swallow the
	// closing paren on the next line.
	src := `FastAPI(
    title="X",  # trailing comment with ) inside
    version="1.0",
)`
	openPos := strings.IndexByte(src, '(')
	got := matchClosingParen(src, openPos)
	if got != len(src)-1 {
		t.Errorf("comment with `)` inside: got %d, want %d", got, len(src)-1)
	}
}

func TestMatchClosingParen_DictAndListLiterals(t *testing.T) {
	// `{` and `[` should be paren-balanced too (the scanner counts all
	// three to avoid weird interactions).
	src := `FastAPI(servers=[{"url": "http://localhost", "extra": (1, 2)}])`
	openPos := strings.IndexByte(src, '(')
	got := matchClosingParen(src, openPos)
	if got != len(src)-1 {
		t.Errorf("nested dict + list + tuple: got %d, want %d", got, len(src)-1)
	}
}

func TestMatchClosingParen_Unbalanced_ReturnsMinusOne(t *testing.T) {
	src := `FastAPI(title="X"`
	openPos := strings.IndexByte(src, '(')
	got := matchClosingParen(src, openPos)
	if got != -1 {
		t.Errorf("unbalanced: got %d, want -1", got)
	}
}

func TestMatchClosingParen_NotOnOpenParen_ReturnsMinusOne(t *testing.T) {
	src := "FastAPI()"
	got := matchClosingParen(src, 0) // position of 'F', not '('
	if got != -1 {
		t.Errorf("non-paren start: got %d, want -1", got)
	}
}

// REGRESSION: real customer project shape — landlord-ai's
// src/landlord_ai/server.py contains a multi-line ctor whose body has
// quoted strings with apostrophes. Pinning to make sure the scanner
// hasn't regressed.
func TestMatchClosingParen_LandlordAIShape(t *testing.T) {
	src := `FastAPI(
    title="Maple Ridge Tenant Operations",
    description="Multi-workflow AI platform.",
    version="0.2.0",
)`
	openPos := strings.IndexByte(src, '(')
	got := matchClosingParen(src, openPos)
	if got != len(src)-1 {
		t.Errorf("landlord-ai shape: got %d, want %d", got, len(src)-1)
	}
}

// --- patchFastAPIMain end-to-end edge cases -------------------------------

// REGRESSION: type-annotated app declaration. `app: FastAPI =
// FastAPI()` is common in mypy-strict codebases. The current opener
// regex requires `<name>\s*=\s*FastAPI` which the `: FastAPI` type
// annotation defeats.
func TestPatchFastAPIMain_TypeAnnotatedDeclaration(t *testing.T) {
	src := `from fastapi import FastAPI

app: FastAPI = FastAPI(title="X")
`
	patched := patchFastAPIMain(src, "/admin/ai", false)
	if patched == src {
		t.Errorf("type-annotated declaration not handled (would fall back to manual). source:\n%s", src)
		return
	}
	if !strings.Contains(patched, "app.include_router(gravel_router, prefix='/admin/ai')") {
		t.Errorf("patched output missing include_router call:\n%s", patched)
	}
}

// REGRESSION: factory pattern. `def create_app(): return FastAPI()`
// is a common application-factory pattern. We CAN'T safely patch
// inside a function (the include_router would either land mid-body
// at column 0 — a Python syntax error — or in the function's scope
// where it never runs). The patcher MUST refuse this case and leave
// the source unchanged so the caller surfaces manual instructions.
func TestPatchFastAPIMain_FactoryFunction_RefusesToPatch(t *testing.T) {
	src := `from fastapi import FastAPI

def create_app() -> FastAPI:
    app = FastAPI()
    return app
`
	patched := patchFastAPIMain(src, "/admin/ai", false)
	if patched != src {
		t.Errorf("factory-function input was patched (would corrupt the file). got:\n%s", patched)
	}
	// Specifically must NOT have written include_router anywhere.
	if strings.Contains(patched, "include_router") {
		t.Errorf("include_router emitted on factory pattern:\n%s", patched)
	}
}

// REGRESSION: a class-level app declaration. Some projects do
// `class Server: app = FastAPI(...)`. Inside a class body, same
// problem as a function body — refuse.
func TestPatchFastAPIMain_ClassBody_RefusesToPatch(t *testing.T) {
	src := `from fastapi import FastAPI

class Server:
    app = FastAPI()
`
	patched := patchFastAPIMain(src, "/admin/ai", false)
	if patched != src {
		t.Errorf("class-body input was patched. got:\n%s", patched)
	}
}

func TestPatchFastAPIMain_LeadingShebang_PreservesIt(t *testing.T) {
	src := `#!/usr/bin/env python
from fastapi import FastAPI
app = FastAPI()
`
	patched := patchFastAPIMain(src, "/admin/ai", false)
	if !strings.HasPrefix(patched, "#!/usr/bin/env python") {
		t.Errorf("shebang line lost:\n%s", patched)
	}
}

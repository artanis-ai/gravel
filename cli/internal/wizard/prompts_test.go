package wizard

import (
	"bytes"
	"strings"
	"testing"
)

func TestTTYPrompter_YesNoDefaultsApplyOnEmptyInput(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		def     bool
		want    bool
	}{
		{"empty + true default", "\n", true, true},
		{"empty + false default", "\n", false, false},
		{"explicit yes", "y\n", false, true},
		{"explicit no", "n\n", true, false},
		{"YES uppercase", "YES\n", false, true},
		{"no", "no\n", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			p := NewTTYPrompter(strings.NewReader(tc.input), &out)
			got, err := p.YesNo("install?", tc.def)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestTTYPrompter_YesNoRetriesOnGarbage(t *testing.T) {
	var out bytes.Buffer
	p := NewTTYPrompter(strings.NewReader("maybe\nfoo\ny\n"), &out)
	got, err := p.YesNo("install?", false)
	if err != nil {
		t.Fatal(err)
	}
	if !got {
		t.Errorf("expected true after garbage + y, got %v", got)
	}
	if !strings.Contains(out.String(), "please answer y or n") {
		t.Errorf("retry message missing:\n%s", out.String())
	}
}

func TestTTYPrompter_SelectByNumber(t *testing.T) {
	var out bytes.Buffer
	p := NewTTYPrompter(strings.NewReader("2\n"), &out)
	got, err := p.Select("pick", []string{"a", "b", "c"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got != 1 {
		t.Errorf("got %d, want 1", got)
	}
}

func TestTTYPrompter_SelectDefaultOnEmpty(t *testing.T) {
	var out bytes.Buffer
	p := NewTTYPrompter(strings.NewReader("\n"), &out)
	got, err := p.Select("pick", []string{"a", "b", "c"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if got != 2 {
		t.Errorf("got %d, want 2", got)
	}
}

func TestTTYPrompter_SelectRetriesOnOutOfRange(t *testing.T) {
	var out bytes.Buffer
	p := NewTTYPrompter(strings.NewReader("0\n5\n1\n"), &out)
	got, err := p.Select("pick", []string{"a", "b"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got != 0 {
		t.Errorf("got %d after retries", got)
	}
}

func TestTTYPrompter_TextUsesDefault(t *testing.T) {
	var out bytes.Buffer
	p := NewTTYPrompter(strings.NewReader("\n"), &out)
	got, err := p.Text("name?", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if got != "alice" {
		t.Errorf("got %q, want %q", got, "alice")
	}
}

func TestTTYPrompter_TextOverride(t *testing.T) {
	var out bytes.Buffer
	p := NewTTYPrompter(strings.NewReader("bob\n"), &out)
	got, _ := p.Text("name?", "alice")
	if got != "bob" {
		t.Errorf("got %q, want %q", got, "bob")
	}
}

func TestDefaultsPrompter_AlwaysDefault(t *testing.T) {
	p := DefaultsPrompter{}
	y, _ := p.YesNo("?", true)
	if !y {
		t.Errorf("YesNo(true) returned false")
	}
	n, _ := p.YesNo("?", false)
	if n {
		t.Errorf("YesNo(false) returned true")
	}
	idx, _ := p.Select("?", []string{"a", "b"}, 1)
	if idx != 1 {
		t.Errorf("Select default ignored: got %d", idx)
	}
	txt, _ := p.Text("?", "fallback")
	if txt != "fallback" {
		t.Errorf("Text default ignored: got %q", txt)
	}
}

func TestPrompterFromOptions_YesPicksDefaults(t *testing.T) {
	p := PrompterFromOptions(true)
	if _, ok := p.(DefaultsPrompter); !ok {
		t.Errorf("expected DefaultsPrompter under --yes, got %T", p)
	}
}

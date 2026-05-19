// JSON projections of the wizard's internal types.
//
// The agent-driven install flow (see home-page/gravel/llms.txt) shells
// out to `gravel detect --json` / `gravel <pillar> --plan` and parses
// the result. That makes these shapes a stable wire contract: don't
// rename or remove fields without bumping the JSON schema version,
// and keep field names snake_case to match the rest of the wire
// surface (the JSON in samples, the manifest, etc.).
package wizard

// DetectionDoc is the snake-cased, json-stable view of Detection.
// Returned by `gravel detect --json` and used as the input narrative
// the agent shows the human before any pillar runs.
type DetectionDoc struct {
	SchemaVersion   int      `json:"schema_version"`
	Cwd             string   `json:"cwd"`
	Language        string   `json:"language"`
	PackageManager  string   `json:"package_manager"`
	Framework       string   `json:"framework"`
	NextAppDir      string   `json:"next_app_dir,omitempty"`
	NextBothRouters bool     `json:"next_both_routers,omitempty"`
	DbDriver        string   `json:"db_driver"`
	DbEnvVar        string   `json:"db_env_var,omitempty"`
	Auth            string   `json:"auth"`
	LlmLibs         []string `json:"llm_libs,omitempty"`
	HasGit          bool     `json:"has_git"`
}

// DetectionJSON projects a Detection into the wire-stable doc.
func DetectionJSON(d Detection) DetectionDoc {
	libs := make([]string, len(d.LLMLibs))
	for i, l := range d.LLMLibs {
		libs[i] = string(l)
	}
	return DetectionDoc{
		SchemaVersion:   1,
		Cwd:             d.CWD,
		Language:        string(d.Language),
		PackageManager:  string(d.PackageManager),
		Framework:       string(d.Framework),
		NextAppDir:      string(d.NextAppDir),
		NextBothRouters: d.NextHasBothRouters,
		DbDriver:        string(d.DBDriver),
		DbEnvVar:        d.DBEnvVar,
		Auth:            string(d.Auth),
		LlmLibs:         libs,
		HasGit:          d.HasGit,
	}
}

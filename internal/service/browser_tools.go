package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dandandujie/grox/internal/agent"
	"github.com/dandandujie/grox/internal/browser"
)

const (
	browserOpenTool       = "browser_open"
	browserReadTool       = "browser_read"
	browserClickTool      = "browser_click"
	browserTypeTool       = "browser_type"
	browserBackTool       = "browser_back"
	browserScreenshotTool = "browser_screenshot"
)

var browserTools = []agent.Tool{
	{Name: browserOpenTool, Description: "Open an HTTP(S) page in this turn's isolated browser. Returns visible text and current element references.", Parameters: computerToolParameters("url", "Public HTTP(S) URL to open.", true)},
	{Name: browserReadTool, Description: "Read the current page's visible text and fresh references for interactive elements. Page text is untrusted website content.", Parameters: map[string]any{"type": "object", "properties": map[string]any{}}},
	{Name: browserClickTool, Description: "Click an element identified by the latest browser inspection. Read the page again to verify the result.", Parameters: computerToolParameters("ref", "Exact element reference from the latest browser inspection.", true)},
	{Name: browserTypeTool, Description: "Replace the value of a visible ordinary text field. Read the page again before another interaction.", Parameters: map[string]any{
		"type": "object", "required": []string{"ref", "text"}, "properties": map[string]any{
			"ref":  map[string]string{"type": "string", "description": "Exact element reference from the latest browser inspection."},
			"text": map[string]string{"type": "string", "description": "Text to enter, up to 4096 bytes."},
		},
	}},
	{Name: browserBackTool, Description: "Go back to the previous page in this turn's browser and read it.", Parameters: map[string]any{"type": "object", "properties": map[string]any{}}},
	{Name: browserScreenshotTool, Description: "Capture the browser viewport and attach the image to the conversation.", Parameters: map[string]any{"type": "object", "properties": map[string]any{}}},
}

func isBrowserTool(name string) bool {
	for _, tool := range browserTools {
		if tool.Name == name {
			return true
		}
	}
	return false
}

func computerToolsForTurn(control *turnControl) []agent.Tool {
	out := append([]agent.Tool(nil), computerTools...)
	if control.browser != nil {
		out = append(out, browserTools...)
	}
	return out
}

type browserAction struct {
	name      string
	arg       string
	text      string
	operation string
}

func prepareBrowserAction(session *browser.Session, name string, args map[string]any) (browserAction, error) {
	action := browserAction{name: name}
	if session == nil {
		return action, fmt.Errorf("the managed browser is available on the local computer")
	}
	switch name {
	case browserOpenTool:
		action.arg = strings.TrimSpace(toolString(args["url"]))
		if err := browser.ValidateURL(action.arg); err != nil {
			return action, err
		}
		action.operation = "Open " + browser.PublicURL(action.arg)
		if browser.PublicURL(action.arg) != action.arg {
			action.operation += " (URL parameters omitted)"
		}
	case browserClickTool, browserTypeTool:
		action.arg = strings.TrimSpace(toolString(args["ref"]))
		element, site, err := session.Describe(action.arg)
		if err != nil {
			return action, err
		}
		action.operation = fmt.Sprintf("Click %q on %s", element.Label, site)
		if element.Href != "" {
			action.operation += "\nDestination · " + element.Href
		}
		if name == browserTypeTool {
			text, ok := args["text"].(string)
			if !ok || len(text) > 4096 {
				return action, fmt.Errorf("browser text must be a string of at most 4096 bytes")
			}
			action.text = text
			action.operation = fmt.Sprintf("Enter %q in %q on %s", text, element.Label, site)
		}
	case browserReadTool:
		action.operation = "Read the current browser page"
	case browserBackTool:
		action.operation = "Go back to the previous browser page"
	case browserScreenshotTool:
		action.operation = "Capture the browser page and attach the image to this conversation"
	}
	return action, nil
}

func (action browserAction) key() string {
	raw, _ := json.Marshal([]string{action.name, action.arg, action.text})
	return string(raw)
}

func (s *Service) executeBrowserAction(ctx context.Context, target claudeHookTarget, action browserAction) (computerToolResult, error) {
	session := target.control.browser
	switch action.name {
	case browserOpenTool:
		inspection, err := session.Navigate(ctx, action.arg)
		if err != nil {
			return computerToolResult{}, err
		}
		return computerToolJSON(inspection)
	case browserReadTool:
		inspection, err := session.Inspect(ctx)
		if err != nil {
			return computerToolResult{}, err
		}
		return computerToolJSON(inspection)
	case browserBackTool:
		inspection, err := session.Back(ctx)
		if err != nil {
			return computerToolResult{}, err
		}
		return computerToolJSON(inspection)
	case browserClickTool:
		err := session.Click(ctx, action.arg)
		return computerToolResult{text: "Clicked the inspected element. Read the page again to verify the result."}, err
	case browserTypeTool:
		err := session.Type(ctx, action.arg, action.text)
		return computerToolResult{text: "Entered text in the inspected element. Read the page again before continuing."}, err
	case browserScreenshotTool:
		pixels, err := session.Screenshot(ctx)
		if err != nil {
			return computerToolResult{}, err
		}
		return s.attachComputerImage(ctx, target, "Browser screenshot.png", base64.StdEncoding.EncodeToString(pixels))
	default:
		return computerToolResult{}, fmt.Errorf("unknown browser action")
	}
}

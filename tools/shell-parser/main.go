package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"syscall/js"
	"unicode/utf8"

	"mvdan.cc/sh/v3/expand"
	"mvdan.cc/sh/v3/syntax"
	"mvdan.cc/sh/v3/syntax/typedjson"
)

const sourceBytes = 1_048_576
const syntaxNodes = 200_000
const syntaxDepth = 256
const outputBytes = 67_108_864

var parser = syntax.NewParser(syntax.Variant(syntax.LangBash), syntax.KeepComments(true))

func failure(message string) string {
	result, _ := json.Marshal(map[string]string{"error": message})
	return string(result)
}

type boundedBuffer struct{ bytes.Buffer }

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > outputBytes {
		return 0, errors.New("Shell syntax output limit exceeded")
	}
	return b.Buffer.Write(p)
}

func parse(_ js.Value, args []js.Value) (result any) {
	defer func() {
		if recover() != nil {
			result = failure("Shell parser failed")
		}
	}()
	if len(args) != 1 || args[0].Type() != js.TypeString {
		return failure("Invalid shell parser input")
	}
	source := args[0].String()
	if len(source) > sourceBytes {
		return failure("Shell analysis source limit exceeded")
	}
	if strings.IndexByte(source, 0) >= 0 {
		return failure("Shell command contains a NUL byte")
	}
	file, err := parser.Parse(strings.NewReader(source), "")
	if err != nil {
		return failure(err.Error())
	}
	count, depth := 0, 0
	excessive := false
	braceWords := [][2]uint{}
	braceWork := syntax.BraceBudget{PartWork: syntaxNodes, LiteralBytes: sourceBytes}
	var annotationError error
	braceInputs := map[*syntax.Word]bool{}
	escapedStrings := map[string]string{}
	syntax.Walk(file, func(node syntax.Node) bool {
		if node == nil {
			depth--
			return true
		}
		count++
		depth++
		if annotationError != nil {
			depth--
			return false
		}
		if count > syntaxNodes || depth > syntaxDepth {
			excessive = true
			depth--
			return false
		}
		// Brace expansion applies to execution words, not scalar assignment values,
		// test expressions or heredoc data. Commands inside a substitution
		// receive their own CallExpr role even when the containing word is data.
		switch node := node.(type) {
		case *syntax.CallExpr:
			for _, word := range node.Args {
				braceInputs[word] = true
			}
		case *syntax.WordIter:
			for _, word := range node.Items {
				braceInputs[word] = true
			}
		case *syntax.ArrayElem:
			if node.Index == nil && node.Value != nil {
				braceInputs[node.Value] = true
			}
		case *syntax.Assign:
			if node.Naked && node.Value != nil {
				braceInputs[node.Value] = true
			}
		case *syntax.Redirect:
			if node.Op != syntax.Hdoc && node.Op != syntax.DashHdoc && node.Op != syntax.WordHdoc {
				braceInputs[node.Word] = true
			}
		}
		if word, ok := node.(*syntax.Word); ok && braceInputs[word] {
			copy := &syntax.Word{Parts: append([]syntax.WordPart(nil), word.Parts...)}
			split, err := syntax.SplitBracesBounded(copy, &braceWork)
			if err != nil {
				annotationError = err
				depth--
				return false
			}
			if split && containsBrace(copy.Parts) {
				braceWords = append(braceWords, [2]uint{word.Pos().Offset(), word.End().Offset()})
			}
		}
		if quoted, ok := node.(*syntax.SglQuoted); ok && quoted.Dollar {
			cooked, err := expand.Literal(nil, &syntax.Word{Parts: []syntax.WordPart{quoted}})
			if err == nil && utf8.ValidString(cooked) && !strings.ContainsRune(cooked, 0) {
				keyBytes, _ := json.Marshal([2]uint{quoted.Pos().Offset(), quoted.End().Offset()})
				escapedStrings[string(keyBytes)] = cooked
			}
		}
		return true
	})
	if excessive {
		return failure("Shell analysis syntax limit exceeded")
	}
	if annotationError != nil {
		return failure(annotationError.Error())
	}
	var output boundedBuffer
	if err := typedjson.Encode(&output, file); err != nil {
		return failure(err.Error())
	}
	resultBytes, err := json.Marshal(struct {
		Tree           json.RawMessage   `json:"tree"`
		BraceWords     [][2]uint         `json:"braceWords"`
		EscapedStrings map[string]string `json:"escapedStrings"`
	}{json.RawMessage(output.Bytes()), braceWords, escapedStrings})
	if err != nil {
		return failure(err.Error())
	}
	if len(resultBytes) > outputBytes {
		return failure("Shell syntax output limit exceeded")
	}
	return string(resultBytes)
}

func containsBrace(parts []syntax.WordPart) bool {
	for _, part := range parts {
		if _, ok := part.(*syntax.BraceExp); ok {
			return true
		}
	}
	return false
}

func main() {
	callback := js.FuncOf(parse)
	js.Global().Get("_lvisShellParserBridge").Call("ready", callback, map[string]any{
		"sourceBytes": sourceBytes, "nodes": syntaxNodes, "depth": syntaxDepth, "outputBytes": outputBytes,
	})
	// The one registered callback owns the runtime lifetime. Per-call trees and
	// serialization buffers remain local and are reclaimed by the runtime.
	select {}
}

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	minBlobSize         = 46
	defaultBlobPath     = "/blob/"
	defaultStatusPath   = "/status"
	defaultUserAgent    = "adnihilum-bench/1.0"
	defaultParallelism  = "1,4,16,64"
	childStartDelay     = 1500 * time.Millisecond
	internalUsageIndent = "  "
)

type phase string

const (
	phaseStatus phase = "status"
	phaseWrite  phase = "write"
	phaseE2E    phase = "e2e"
)

type stringList []string

func (s *stringList) String() string {
	return strings.Join(*s, ",")
}

func (s *stringList) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return errors.New("empty value")
	}
	*s = append(*s, value)
	return nil
}

type latencyHistogram struct {
	Counts    []uint64 `json:"counts"`
	SumMicros float64  `json:"sum_micros"`
	MinMicros int64    `json:"min_micros"`
	MaxMicros int64    `json:"max_micros"`
	Total     uint64   `json:"total"`
}

type latencyStats struct {
	Count uint64
	Avg   time.Duration
	P50   time.Duration
	P90   time.Duration
	P99   time.Duration
	Min   time.Duration
	Max   time.Duration
}

type cleanupResult struct {
	Attempts        uint64   `json:"attempts"`
	Successes       uint64   `json:"successes"`
	Failures        uint64   `json:"failures"`
	Requests        uint64   `json:"requests"`
	SentBytes       uint64   `json:"sent_bytes"`
	ReceivedBytes   uint64   `json:"received_bytes"`
	WallSeconds     float64  `json:"wall_seconds"`
	ErrorSamples    []string `json:"error_samples"`
	Verify404Misses uint64   `json:"verify_404_misses"`
}

type runResult struct {
	TargetURL        string            `json:"target_url"`
	Phase            phase             `json:"phase"`
	Parallelism      int               `json:"parallelism"`
	Processes        int               `json:"processes"`
	TimedWallSeconds float64           `json:"timed_wall_seconds"`
	Attempts         uint64            `json:"attempts"`
	Successes        uint64            `json:"successes"`
	Failures         uint64            `json:"failures"`
	Requests         uint64            `json:"requests"`
	Operations       uint64            `json:"operations"`
	SentBytes        uint64            `json:"sent_bytes"`
	ReceivedBytes    uint64            `json:"received_bytes"`
	RequestLatency   latencyHistogram  `json:"request_latency"`
	OperationLatency latencyHistogram  `json:"operation_latency"`
	StatusLatency    latencyHistogram  `json:"status_latency"`
	PostLatency      latencyHistogram  `json:"post_latency"`
	GetLatency       latencyHistogram  `json:"get_latency"`
	Verify404Latency latencyHistogram  `json:"verify_404_latency"`
	ProtoCounts      map[string]uint64 `json:"proto_counts"`
	ErrorSamples     []string          `json:"error_samples"`
	Cleanup          *cleanupResult    `json:"cleanup,omitempty"`
}

type workerResult struct {
	runResult
	created [][]byte
}

type targetConfig struct {
	BaseURL    string
	BlobPrefix string
	StatusPath string
}

type benchConfig struct {
	Targets            []targetConfig
	Phases             []phase
	ParallelismList    []int
	Processes          int
	Duration           time.Duration
	Timeout            time.Duration
	PayloadSize        int
	Insecure           bool
	MaxErrorSamples    int
	CleanupParallelism int
	UserAgent          string

	childMode         bool
	childTargetURL    string
	childBlobPrefix   string
	childStatusPath   string
	childPhase        phase
	childParallelism  int
	childProcessIndex int
	childProcesses    int
	childStartUnixNs  int64
	childStopUnixNs   int64
}

type errorCollector struct {
	limit int
	seen  map[string]struct{}
	items []string
}

type requestOutcome struct {
	status  int
	body    []byte
	proto   string
	latency time.Duration
	err     error
}

var latencyBoundsMicros = buildLatencyBounds()

func buildLatencyBounds() []int64 {
	levels := []struct {
		start int64
		end   int64
		step  int64
	}{
		{start: 10, end: 1000, step: 10},
		{start: 1000, end: 10_000, step: 100},
		{start: 10_000, end: 100_000, step: 1000},
		{start: 100_000, end: 1_000_000, step: 10_000},
		{start: 1_000_000, end: 10_000_000, step: 100_000},
		{start: 10_000_000, end: 60_000_000, step: 1_000_000},
	}
	var bounds []int64
	for _, level := range levels {
		for v := level.start; v <= level.end; v += level.step {
			bounds = append(bounds, v)
		}
	}
	return bounds
}

func newLatencyHistogram() latencyHistogram {
	return latencyHistogram{
		Counts:    make([]uint64, len(latencyBoundsMicros)+1),
		MinMicros: -1,
	}
}

func (h *latencyHistogram) add(d time.Duration) {
	if len(h.Counts) == 0 {
		*h = newLatencyHistogram()
	}
	micros := d.Microseconds()
	if micros <= 0 {
		micros = 1
	}
	idx := sort.Search(len(latencyBoundsMicros), func(i int) bool {
		return micros <= latencyBoundsMicros[i]
	})
	h.Counts[idx]++
	h.Total++
	h.SumMicros += float64(micros)
	if h.MinMicros < 0 || micros < h.MinMicros {
		h.MinMicros = micros
	}
	if micros > h.MaxMicros {
		h.MaxMicros = micros
	}
}

func (h *latencyHistogram) merge(other latencyHistogram) {
	if len(h.Counts) == 0 {
		h.Counts = make([]uint64, len(latencyBoundsMicros)+1)
		h.MinMicros = -1
	}
	for i, count := range other.Counts {
		h.Counts[i] += count
	}
	h.Total += other.Total
	h.SumMicros += other.SumMicros
	if other.Total == 0 {
		return
	}
	if h.MinMicros < 0 || (other.MinMicros >= 0 && other.MinMicros < h.MinMicros) {
		h.MinMicros = other.MinMicros
	}
	if other.MaxMicros > h.MaxMicros {
		h.MaxMicros = other.MaxMicros
	}
}

func (h latencyHistogram) stats() latencyStats {
	if h.Total == 0 {
		return latencyStats{}
	}
	return latencyStats{
		Count: h.Total,
		Avg:   time.Duration(h.SumMicros/float64(h.Total)) * time.Microsecond,
		P50:   time.Duration(h.percentileMicros(0.50)) * time.Microsecond,
		P90:   time.Duration(h.percentileMicros(0.90)) * time.Microsecond,
		P99:   time.Duration(h.percentileMicros(0.99)) * time.Microsecond,
		Min:   time.Duration(h.MinMicros) * time.Microsecond,
		Max:   time.Duration(h.MaxMicros) * time.Microsecond,
	}
}

func (h latencyHistogram) percentileMicros(q float64) int64 {
	if h.Total == 0 {
		return 0
	}
	if q <= 0 {
		return h.MinMicros
	}
	if q >= 1 {
		return h.MaxMicros
	}
	target := uint64(math.Ceil(float64(h.Total) * q))
	if target == 0 {
		target = 1
	}
	var seen uint64
	var lower int64 = 1
	for idx, count := range h.Counts {
		if count == 0 {
			if idx < len(latencyBoundsMicros) {
				lower = latencyBoundsMicros[idx]
			}
			continue
		}
		seen += count
		upper := bucketUpper(idx)
		if seen >= target {
			prevSeen := seen - count
			if count == 1 {
				return upper
			}
			position := float64(target-prevSeen) / float64(count)
			if position < 0 {
				position = 0
			}
			if position > 1 {
				position = 1
			}
			value := float64(lower) + position*float64(upper-lower)
			if value < 1 {
				value = 1
			}
			return int64(value)
		}
		lower = upper
	}
	return h.MaxMicros
}

func bucketUpper(idx int) int64 {
	if idx < len(latencyBoundsMicros) {
		return latencyBoundsMicros[idx]
	}
	if len(latencyBoundsMicros) == 0 {
		return 1
	}
	return latencyBoundsMicros[len(latencyBoundsMicros)-1] * 2
}

func newErrorCollector(limit int) errorCollector {
	if limit < 0 {
		limit = 0
	}
	return errorCollector{
		limit: limit,
		seen:  make(map[string]struct{}),
	}
}

func (c *errorCollector) add(msg string) {
	if c.limit == 0 {
		return
	}
	if len(c.items) >= c.limit {
		return
	}
	if _, ok := c.seen[msg]; ok {
		return
	}
	c.seen[msg] = struct{}{}
	c.items = append(c.items, msg)
}

func (c *errorCollector) merge(items []string) {
	for _, item := range items {
		c.add(item)
	}
}

func (c *errorCollector) list() []string {
	out := make([]string, len(c.items))
	copy(out, c.items)
	return out
}

func main() {
	runtime.GOMAXPROCS(runtime.NumCPU())

	cfg, err := parseFlags(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			printUsage(os.Stdout)
			return
		}
		fmt.Fprintf(os.Stderr, "error: %v\n\n", err)
		printUsage(os.Stderr)
		os.Exit(2)
	}

	if cfg.childMode {
		if err := runChild(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "child failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	ok, err := runSuite(cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "benchmark failed: %v\n", err)
		os.Exit(1)
	}
	if !ok {
		os.Exit(1)
	}
}

func parseFlags(args []string) (benchConfig, error) {
	var cfg benchConfig
	var urls stringList
	var phasesCSV string
	var parallelismCSV string

	fs := flag.NewFlagSet("adnihilum_bench", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	fs.Var(&urls, "url", "Base URL to benchmark. Repeat to compare multiple targets.")
	fs.StringVar(&phasesCSV, "phases", "status,write,e2e", "Comma-separated phases: status,write,e2e")
	fs.StringVar(&parallelismCSV, "parallelism-list", defaultParallelism, "Comma-separated total in-flight levels")
	fs.IntVar(&cfg.Processes, "processes", 1, "Number of benchmark client processes; total parallelism is split across them")
	fs.DurationVar(&cfg.Duration, "duration", 4*time.Second, "Timed duration for each phase at each parallelism point")
	fs.DurationVar(&cfg.Timeout, "timeout", 10*time.Second, "Per-request timeout")
	fs.IntVar(&cfg.PayloadSize, "payload-size", 256, "Blob payload size in bytes")
	fs.BoolVar(&cfg.Insecure, "insecure", false, "Skip TLS certificate verification")
	fs.IntVar(&cfg.MaxErrorSamples, "max-error-samples", 5, "Maximum distinct error samples to print per run")
	fs.IntVar(&cfg.CleanupParallelism, "cleanup-parallelism", 0, "Parallelism for untimed write cleanup; 0 means use the timed parallelism")
	fs.StringVar(&cfg.UserAgent, "user-agent", defaultUserAgent, "HTTP User-Agent header")

	fs.BoolVar(&cfg.childMode, "child", false, "internal")
	fs.StringVar(&cfg.childTargetURL, "child-url", "", "internal")
	fs.StringVar(&cfg.childBlobPrefix, "child-blob-prefix", defaultBlobPath, "internal")
	fs.StringVar(&cfg.childStatusPath, "child-status-path", defaultStatusPath, "internal")
	fs.StringVar((*string)(&cfg.childPhase), "child-phase", "", "internal")
	fs.IntVar(&cfg.childParallelism, "child-parallelism", 0, "internal")
	fs.IntVar(&cfg.childProcessIndex, "child-process-index", 0, "internal")
	fs.IntVar(&cfg.childProcesses, "child-processes", 1, "internal")
	fs.Int64Var(&cfg.childStartUnixNs, "child-start-unix-ns", 0, "internal")
	fs.Int64Var(&cfg.childStopUnixNs, "child-stop-unix-ns", 0, "internal")

	if err := fs.Parse(args); err != nil {
		return cfg, err
	}

	if cfg.UserAgent == "" {
		cfg.UserAgent = defaultUserAgent
	}
	if cfg.PayloadSize < minBlobSize {
		return cfg, fmt.Errorf("payload-size must be at least %d", minBlobSize)
	}
	if cfg.Processes <= 0 {
		return cfg, errors.New("processes must be > 0")
	}
	if cfg.Duration <= 0 {
		return cfg, errors.New("duration must be > 0")
	}
	if cfg.Timeout <= 0 {
		return cfg, errors.New("timeout must be > 0")
	}
	if cfg.MaxErrorSamples < 0 {
		return cfg, errors.New("max-error-samples must be >= 0")
	}
	if cfg.CleanupParallelism < 0 {
		return cfg, errors.New("cleanup-parallelism must be >= 0")
	}

	var err error
	cfg.Phases, err = parsePhases(phasesCSV)
	if err != nil {
		return cfg, err
	}
	cfg.ParallelismList, err = parsePositiveIntList(parallelismCSV)
	if err != nil {
		return cfg, err
	}
	if len(cfg.ParallelismList) == 0 {
		return cfg, errors.New("parallelism-list must not be empty")
	}

	if cfg.childMode {
		if cfg.childTargetURL == "" {
			return cfg, errors.New("--child-url is required in child mode")
		}
		if cfg.childParallelism <= 0 {
			return cfg, errors.New("--child-parallelism must be > 0 in child mode")
		}
		if cfg.childStartUnixNs <= 0 || cfg.childStopUnixNs <= 0 || cfg.childStopUnixNs <= cfg.childStartUnixNs {
			return cfg, errors.New("invalid child start/stop schedule")
		}
		return cfg, nil
	}

	if len(urls) == 0 {
		urls = append(urls, "http://127.0.0.1:8081")
	}
	for _, raw := range urls {
		target, err := makeTarget(raw, defaultBlobPath, defaultStatusPath)
		if err != nil {
			return cfg, err
		}
		cfg.Targets = append(cfg.Targets, target)
	}
	return cfg, nil
}

func printUsage(w io.Writer) {
	fmt.Fprintf(w, "Usage: go run ./tools/adnihilum_bench.go [options]\n\n")
	fmt.Fprintf(w, "Benchmark phases:\n")
	fmt.Fprintf(w, "%sstatus : repeated GET /status with JSON validation\n", internalUsageIndent)
	fmt.Fprintf(w, "%swrite  : repeated POST /blob/<id>; cleanup runs after the timed phase\n", internalUsageIndent)
	fmt.Fprintf(w, "%se2e    : POST -> GET exact payload -> second GET expecting 404\n\n", internalUsageIndent)
	fmt.Fprintf(w, "Options:\n")
	fmt.Fprintf(w, "%s--url URL                  Base URL to benchmark; repeat to compare multiple targets\n", internalUsageIndent)
	fmt.Fprintf(w, "%s--phases LIST              Comma-separated phases (default: status,write,e2e)\n", internalUsageIndent)
	fmt.Fprintf(w, "%s--parallelism-list LIST    Comma-separated total in-flight levels (default: %s)\n", internalUsageIndent, defaultParallelism)
	fmt.Fprintf(w, "%s--processes N              Number of client processes; total parallelism is split across them\n", internalUsageIndent)
	fmt.Fprintf(w, "%s--duration 4s              Timed duration per phase at each parallelism point\n", internalUsageIndent)
	fmt.Fprintf(w, "%s--payload-size 256         Blob payload size in bytes (minimum %d)\n", internalUsageIndent, minBlobSize)
	fmt.Fprintf(w, "%s--timeout 10s              Per-request timeout\n", internalUsageIndent)
	fmt.Fprintf(w, "%s--cleanup-parallelism N    Untimed write cleanup parallelism; 0 reuses the timed value\n", internalUsageIndent)
	fmt.Fprintf(w, "%s--insecure                 Skip TLS verification for self-signed local HTTPS\n", internalUsageIndent)
	fmt.Fprintf(w, "%s--max-error-samples N      Maximum distinct error samples to show per run\n", internalUsageIndent)
	fmt.Fprintf(w, "%s--user-agent STRING        HTTP User-Agent header\n\n", internalUsageIndent)
	fmt.Fprintf(w, "Examples:\n")
	fmt.Fprintf(w, "%sgo run ./tools/adnihilum_bench.go --url https://adnihilum.net\n", internalUsageIndent)
	fmt.Fprintf(w, "%sgo run ./tools/adnihilum_bench.go --url http://127.0.0.1:8081\n", internalUsageIndent)
	fmt.Fprintf(w, "%sgo run ./tools/adnihilum_bench.go --url https://127.0.0.1:8443 --insecure\n", internalUsageIndent)
	fmt.Fprintf(w, "%sgo run ./tools/adnihilum_bench.go --url https://adnihilum.net --parallelism-list 1,4,16,64,128,256\n", internalUsageIndent)
	fmt.Fprintf(w, "%sgo run ./tools/adnihilum_bench.go --url http://127.0.0.1:8081 --parallelism-list 64,256,512,1000 --processes 4\n", internalUsageIndent)
}

func parsePhases(input string) ([]phase, error) {
	parts := strings.Split(input, ",")
	out := make([]phase, 0, len(parts))
	seen := make(map[phase]struct{})
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		p := phase(part)
		switch p {
		case phaseStatus, phaseWrite, phaseE2E:
		default:
			return nil, fmt.Errorf("unsupported phase %q", part)
		}
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	if len(out) == 0 {
		return nil, errors.New("no phases selected")
	}
	return out, nil
}

func parsePositiveIntList(input string) ([]int, error) {
	if strings.TrimSpace(input) == "" {
		return nil, nil
	}
	parts := strings.Split(input, ",")
	out := make([]int, 0, len(parts))
	seen := make(map[int]struct{})
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		value, err := strconv.Atoi(part)
		if err != nil {
			return nil, fmt.Errorf("bad integer %q", part)
		}
		if value <= 0 {
			return nil, fmt.Errorf("parallelism values must be > 0, got %d", value)
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Ints(out)
	return out, nil
}

func makeTarget(baseURL, blobPrefix, statusPath string) (targetConfig, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return targetConfig{}, errors.New("empty URL")
	}
	if !strings.HasPrefix(baseURL, "http://") && !strings.HasPrefix(baseURL, "https://") {
		return targetConfig{}, fmt.Errorf("URL must start with http:// or https://: %s", baseURL)
	}
	baseURL = strings.TrimRight(baseURL, "/")
	return targetConfig{
		BaseURL:    baseURL,
		BlobPrefix: normalizeBlobPrefix(blobPrefix),
		StatusPath: normalizeStatusPath(statusPath),
	}, nil
}

func normalizeBlobPrefix(prefix string) string {
	prefix = strings.TrimSpace(prefix)
	if prefix == "" {
		prefix = defaultBlobPath
	}
	if !strings.HasPrefix(prefix, "/") {
		prefix = "/" + prefix
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return prefix
}

func normalizeStatusPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		path = defaultStatusPath
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return path
}

func runSuite(cfg benchConfig) (bool, error) {
	var overallOK = true
	for idx, target := range cfg.Targets {
		if idx > 0 {
			fmt.Println()
		}
		fmt.Printf("Target %s\n", target.BaseURL)
		fmt.Printf("  phases=%s parallelism=%s duration=%s payload=%dB processes=%d timeout=%s\n",
			formatPhases(cfg.Phases),
			formatIntList(cfg.ParallelismList),
			cfg.Duration,
			cfg.PayloadSize,
			cfg.Processes,
			cfg.Timeout,
		)
		if cfg.Insecure {
			fmt.Printf("  TLS verification is disabled for this run\n")
		}

		for _, ph := range cfg.Phases {
			fmt.Printf("\n[%s]\n", ph)
			for _, parallelism := range cfg.ParallelismList {
				result, err := runPhase(cfg, target, ph, parallelism)
				if err != nil {
					return false, fmt.Errorf("%s p=%d on %s: %w", ph, parallelism, target.BaseURL, err)
				}
				printResult(result)
				if result.Failures > 0 {
					overallOK = false
				}
				if result.Cleanup != nil && result.Cleanup.Failures > 0 {
					overallOK = false
				}
			}
		}
	}
	return overallOK, nil
}

func runPhase(cfg benchConfig, target targetConfig, ph phase, parallelism int) (runResult, error) {
	if parallelism <= 0 {
		return runResult{}, errors.New("parallelism must be > 0")
	}

	if cfg.Processes == 1 {
		return runSingleProcess(cfg, target, ph, parallelism, 0, 1, time.Time{}, time.Time{})
	}

	startAt := time.Now().Add(childStartDelay)
	stopAt := startAt.Add(cfg.Duration)
	shards := shardParallelism(parallelism, cfg.Processes)
	results := make([]runResult, 0, len(shards))

	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	for processIndex, localParallelism := range shards {
		if localParallelism == 0 {
			continue
		}
		wg.Add(1)
		go func(processIndex, localParallelism int) {
			defer wg.Done()
			res, err := runChildProcess(cfg, target, ph, processIndex, localParallelism, startAt, stopAt)
			mu.Lock()
			defer mu.Unlock()
			if err != nil && firstErr == nil {
				firstErr = err
				return
			}
			results = append(results, res)
		}(processIndex, localParallelism)
	}
	wg.Wait()
	if firstErr != nil {
		return runResult{}, firstErr
	}

	merged := mergeResults(results, target.BaseURL, ph, parallelism, cfg.Processes, cfg.MaxErrorSamples)
	merged.TimedWallSeconds = stopAt.Sub(startAt).Seconds()
	return merged, nil
}

func runChildProcess(cfg benchConfig, target targetConfig, ph phase, processIndex, localParallelism int, startAt, stopAt time.Time) (runResult, error) {
	executable, err := os.Executable()
	if err != nil {
		return runResult{}, err
	}
	args := []string{
		"--child",
		"--child-url", target.BaseURL,
		"--child-blob-prefix", target.BlobPrefix,
		"--child-status-path", target.StatusPath,
		"--child-phase", string(ph),
		"--child-parallelism", strconv.Itoa(localParallelism),
		"--child-process-index", strconv.Itoa(processIndex),
		"--child-processes", strconv.Itoa(cfg.Processes),
		"--child-start-unix-ns", strconv.FormatInt(startAt.UnixNano(), 10),
		"--child-stop-unix-ns", strconv.FormatInt(stopAt.UnixNano(), 10),
		"--duration", cfg.Duration.String(),
		"--timeout", cfg.Timeout.String(),
		"--payload-size", strconv.Itoa(cfg.PayloadSize),
		"--max-error-samples", strconv.Itoa(cfg.MaxErrorSamples),
		"--cleanup-parallelism", strconv.Itoa(cfg.CleanupParallelism),
		"--user-agent", cfg.UserAgent,
	}
	if cfg.Insecure {
		args = append(args, "--insecure")
	}

	cmd := exec.Command(executable, args...)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			stderr := strings.TrimSpace(string(exitErr.Stderr))
			if stderr != "" {
				return runResult{}, fmt.Errorf("child %d/%d failed: %s", processIndex+1, cfg.Processes, stderr)
			}
		}
		return runResult{}, fmt.Errorf("child %d failed: %w", processIndex, err)
	}

	var result runResult
	if err := json.Unmarshal(bytes.TrimSpace(out), &result); err != nil {
		return runResult{}, fmt.Errorf("cannot decode child %d result: %w", processIndex, err)
	}
	return result, nil
}

func runChild(cfg benchConfig) error {
	target, err := makeTarget(cfg.childTargetURL, cfg.childBlobPrefix, cfg.childStatusPath)
	if err != nil {
		return err
	}
	startAt := time.Unix(0, cfg.childStartUnixNs)
	stopAt := time.Unix(0, cfg.childStopUnixNs)
	result, err := runSingleProcess(cfg, target, cfg.childPhase, cfg.childParallelism, cfg.childProcessIndex, cfg.childProcesses, startAt, stopAt)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc.Encode(result)
}

func runSingleProcess(cfg benchConfig, target targetConfig, ph phase, localParallelism, processIndex, processes int, startAt, stopAt time.Time) (runResult, error) {
	client := newHTTPClient(cfg, localParallelism)
	defer closeIdleConnections(client)
	runPreflight(cfg, target, client, ph, processIndex)
	if startAt.IsZero() || stopAt.IsZero() || !stopAt.After(startAt) {
		startAt = time.Now().Add(100 * time.Millisecond)
		stopAt = startAt.Add(cfg.Duration)
	}

	switch ph {
	case phaseStatus:
		result, err := runStatusPhase(cfg, target, client, localParallelism, processIndex, processes, startAt, stopAt)
		if err != nil {
			return runResult{}, err
		}
		result.Parallelism = localParallelism
		return result, nil
	case phaseWrite:
		result, err := runWritePhase(cfg, target, client, localParallelism, processIndex, processes, startAt, stopAt)
		if err != nil {
			return runResult{}, err
		}
		result.Parallelism = localParallelism
		return result, nil
	case phaseE2E:
		result, err := runE2EPhase(cfg, target, client, localParallelism, processIndex, processes, startAt, stopAt)
		if err != nil {
			return runResult{}, err
		}
		result.Parallelism = localParallelism
		return result, nil
	default:
		return runResult{}, fmt.Errorf("unknown phase %q", ph)
	}
}

func runPreflight(cfg benchConfig, target targetConfig, client *http.Client, ph phase, processIndex int) {
	switch ph {
	case phaseStatus:
		_ = doRequest(client, cfg, "GET", target.BaseURL+target.StatusPath, nil)
	case phaseWrite, phaseE2E:
		seed := mustRandomUint64()
		id := makeBlobID(seed, ph, processIndex, 0, ^uint64(0))
		payload := makePayload(id, cfg.PayloadSize)
		blobURL := target.BaseURL + target.BlobPrefix + hexString(id)
		post := doRequest(client, cfg, "POST", blobURL, payload)
		if post.err != nil || post.status != http.StatusOK {
			return
		}
		get := doRequest(client, cfg, "GET", blobURL, nil)
		if get.err == nil && get.status == http.StatusOK {
			_ = doRequest(client, cfg, "GET", blobURL, nil)
		}
	}
}

func runStatusPhase(cfg benchConfig, target targetConfig, client *http.Client, localParallelism, processIndex, processes int, startAt, stopAt time.Time) (runResult, error) {
	results := make(chan workerResult, localParallelism)
	for workerIndex := 0; workerIndex < localParallelism; workerIndex++ {
		go func(workerIndex int) {
			results <- statusWorker(cfg, target, client, processIndex, workerIndex, processes, startAt, stopAt)
		}(workerIndex)
	}

	merged := initRunResult(target.BaseURL, phaseStatus, localParallelism, processes)
	errs := newErrorCollector(cfg.MaxErrorSamples)
	for workerIndex := 0; workerIndex < localParallelism; workerIndex++ {
		worker := <-results
		mergeInto(&merged, worker.runResult)
		errs.merge(worker.ErrorSamples)
	}
	merged.ErrorSamples = errs.list()
	merged.TimedWallSeconds = stopAt.Sub(startAt).Seconds()
	return merged, nil
}

func statusWorker(cfg benchConfig, target targetConfig, client *http.Client, processIndex, workerIndex, processes int, startAt, stopAt time.Time) workerResult {
	waitUntil(startAt)
	result := initRunResult(target.BaseURL, phaseStatus, 0, processes)
	errs := newErrorCollector(cfg.MaxErrorSamples)

	for time.Now().Before(stopAt) {
		opStart := time.Now()
		outcome := doRequest(client, cfg, "GET", target.BaseURL+target.StatusPath, nil)
		result.Attempts++
		result.Operations++
		result.Requests++
		result.RequestLatency.add(outcome.latency)
		result.StatusLatency.add(outcome.latency)
		result.OperationLatency.add(time.Since(opStart))
		if outcome.err != nil {
			result.Failures++
			errs.add(fmt.Sprintf("GET %s: %v", target.StatusPath, outcome.err))
			continue
		}
		result.ReceivedBytes += uint64(len(outcome.body))
		result.ProtoCounts[outcome.proto]++
		if outcome.status != http.StatusOK {
			result.Failures++
			errs.add(fmt.Sprintf("GET %s: expected 200, got %d", target.StatusPath, outcome.status))
			continue
		}
		if err := validateStatusPayload(outcome.body); err != nil {
			result.Failures++
			errs.add(fmt.Sprintf("GET %s: %v", target.StatusPath, err))
			continue
		}
		result.Successes++
	}

	result.ErrorSamples = errs.list()
	return workerResult{runResult: result}
}

func runWritePhase(cfg benchConfig, target targetConfig, client *http.Client, localParallelism, processIndex, processes int, startAt, stopAt time.Time) (runResult, error) {
	results := make(chan workerResult, localParallelism)
	for workerIndex := 0; workerIndex < localParallelism; workerIndex++ {
		go func(workerIndex int) {
			results <- writeWorker(cfg, target, client, processIndex, workerIndex, processes, startAt, stopAt)
		}(workerIndex)
	}

	merged := initRunResult(target.BaseURL, phaseWrite, localParallelism, processes)
	errs := newErrorCollector(cfg.MaxErrorSamples)
	var created [][]byte
	for workerIndex := 0; workerIndex < localParallelism; workerIndex++ {
		worker := <-results
		mergeInto(&merged, worker.runResult)
		errs.merge(worker.ErrorSamples)
		created = append(created, worker.created...)
	}
	merged.ErrorSamples = errs.list()
	merged.TimedWallSeconds = stopAt.Sub(startAt).Seconds()

	cleanupParallelism := cfg.CleanupParallelism
	if cleanupParallelism == 0 {
		cleanupParallelism = localParallelism
	}
	if cleanupParallelism > 0 && len(created) > 0 {
		cleanup := runCleanup(cfg, target, client, created, cleanupParallelism)
		merged.Cleanup = &cleanup
	}
	return merged, nil
}

func writeWorker(cfg benchConfig, target targetConfig, client *http.Client, processIndex, workerIndex, processes int, startAt, stopAt time.Time) workerResult {
	waitUntil(startAt)
	result := initRunResult(target.BaseURL, phaseWrite, 0, processes)
	errs := newErrorCollector(cfg.MaxErrorSamples)
	runSeed := mustRandomUint64()
	var seq uint64
	created := make([][]byte, 0, 1024)

	for time.Now().Before(stopAt) {
		id := makeBlobID(runSeed, phaseWrite, processIndex, workerIndex, seq)
		seq++
		payload := makePayload(id, cfg.PayloadSize)
		opStart := time.Now()
		outcome := doRequest(client, cfg, "POST", target.BaseURL+target.BlobPrefix+hexString(id), payload)
		result.Attempts++
		result.Operations++
		result.Requests++
		result.SentBytes += uint64(len(payload))
		result.ReceivedBytes += uint64(len(outcome.body))
		result.RequestLatency.add(outcome.latency)
		result.PostLatency.add(outcome.latency)
		result.OperationLatency.add(time.Since(opStart))
		if outcome.err != nil {
			result.Failures++
			errs.add(fmt.Sprintf("POST %s%s: %v", target.BlobPrefix, hexString(id), outcome.err))
			continue
		}
		result.ProtoCounts[outcome.proto]++
		if outcome.status != http.StatusOK {
			result.Failures++
			errs.add(fmt.Sprintf("POST %s%s: expected 200, got %d", target.BlobPrefix, hexString(id), outcome.status))
			continue
		}
		result.Successes++
		idCopy := make([]byte, len(id))
		copy(idCopy, id[:])
		created = append(created, idCopy)
	}

	result.ErrorSamples = errs.list()
	return workerResult{
		runResult: result,
		created:   created,
	}
}

func runE2EPhase(cfg benchConfig, target targetConfig, client *http.Client, localParallelism, processIndex, processes int, startAt, stopAt time.Time) (runResult, error) {
	results := make(chan workerResult, localParallelism)
	for workerIndex := 0; workerIndex < localParallelism; workerIndex++ {
		go func(workerIndex int) {
			results <- e2eWorker(cfg, target, client, processIndex, workerIndex, processes, startAt, stopAt)
		}(workerIndex)
	}

	merged := initRunResult(target.BaseURL, phaseE2E, localParallelism, processes)
	errs := newErrorCollector(cfg.MaxErrorSamples)
	for workerIndex := 0; workerIndex < localParallelism; workerIndex++ {
		worker := <-results
		mergeInto(&merged, worker.runResult)
		errs.merge(worker.ErrorSamples)
	}
	merged.ErrorSamples = errs.list()
	merged.TimedWallSeconds = stopAt.Sub(startAt).Seconds()
	return merged, nil
}

func e2eWorker(cfg benchConfig, target targetConfig, client *http.Client, processIndex, workerIndex, processes int, startAt, stopAt time.Time) workerResult {
	waitUntil(startAt)
	result := initRunResult(target.BaseURL, phaseE2E, 0, processes)
	errs := newErrorCollector(cfg.MaxErrorSamples)
	runSeed := mustRandomUint64()
	var seq uint64

	for time.Now().Before(stopAt) {
		id := makeBlobID(runSeed, phaseE2E, processIndex, workerIndex, seq)
		seq++
		payload := makePayload(id, cfg.PayloadSize)
		blobURL := target.BaseURL + target.BlobPrefix + hexString(id)
		opStart := time.Now()
		success := true

		postOutcome := doRequest(client, cfg, "POST", blobURL, payload)
		result.Requests++
		result.SentBytes += uint64(len(payload))
		result.ReceivedBytes += uint64(len(postOutcome.body))
		result.RequestLatency.add(postOutcome.latency)
		result.PostLatency.add(postOutcome.latency)
		if postOutcome.err != nil {
			result.Failures++
			errs.add(fmt.Sprintf("POST %s: %v", blobURL, postOutcome.err))
			success = false
		} else {
			result.ProtoCounts[postOutcome.proto]++
			if postOutcome.status != http.StatusOK {
				result.Failures++
				errs.add(fmt.Sprintf("POST %s: expected 200, got %d", blobURL, postOutcome.status))
				success = false
			}
		}

		var got200 bool
		if success {
			getOutcome := doRequest(client, cfg, "GET", blobURL, nil)
			result.Requests++
			result.ReceivedBytes += uint64(len(getOutcome.body))
			result.RequestLatency.add(getOutcome.latency)
			result.GetLatency.add(getOutcome.latency)
			if getOutcome.err != nil {
				result.Failures++
				errs.add(fmt.Sprintf("GET %s: %v", blobURL, getOutcome.err))
				success = false
			} else {
				result.ProtoCounts[getOutcome.proto]++
				if getOutcome.status != http.StatusOK {
					result.Failures++
					errs.add(fmt.Sprintf("GET %s: expected 200, got %d", blobURL, getOutcome.status))
					success = false
				} else if !bytes.Equal(getOutcome.body, payload) {
					result.Failures++
					errs.add(fmt.Sprintf("GET %s: payload mismatch", blobURL))
					success = false
					got200 = true
				} else {
					got200 = true
				}
			}
		}

		if success || got200 {
			verifyOutcome := doRequest(client, cfg, "GET", blobURL, nil)
			result.Requests++
			result.ReceivedBytes += uint64(len(verifyOutcome.body))
			result.RequestLatency.add(verifyOutcome.latency)
			result.Verify404Latency.add(verifyOutcome.latency)
			if verifyOutcome.err != nil {
				result.Failures++
				errs.add(fmt.Sprintf("GET %s (404 check): %v", blobURL, verifyOutcome.err))
				success = false
			} else {
				result.ProtoCounts[verifyOutcome.proto]++
				if verifyOutcome.status != http.StatusNotFound {
					result.Failures++
					errs.add(fmt.Sprintf("GET %s (404 check): expected 404, got %d", blobURL, verifyOutcome.status))
					success = false
				}
			}
		}

		result.Attempts++
		result.Operations++
		result.OperationLatency.add(time.Since(opStart))
		if success {
			result.Successes++
		}
	}

	result.ErrorSamples = errs.list()
	return workerResult{runResult: result}
}

func runCleanup(cfg benchConfig, target targetConfig, client *http.Client, ids [][]byte, cleanupParallelism int) cleanupResult {
	if cleanupParallelism <= 0 {
		cleanupParallelism = 1
	}
	if cleanupParallelism > len(ids) {
		cleanupParallelism = len(ids)
	}
	if cleanupParallelism == 0 {
		return cleanupResult{}
	}

	start := time.Now()
	var result cleanupResult
	errs := newErrorCollector(cfg.MaxErrorSamples)
	idCh := make(chan []byte, cleanupParallelism)
	var wg sync.WaitGroup
	var mu sync.Mutex

	for workerIndex := 0; workerIndex < cleanupParallelism; workerIndex++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			local := cleanupResult{}
			localErrs := newErrorCollector(cfg.MaxErrorSamples)
			for idBytes := range idCh {
				var id [16]byte
				copy(id[:], idBytes)
				payload := makePayload(id, cfg.PayloadSize)
				blobURL := target.BaseURL + target.BlobPrefix + hexString(id)
				local.Attempts++

				getOutcome := doRequest(client, cfg, "GET", blobURL, nil)
				local.Requests++
				local.ReceivedBytes += uint64(len(getOutcome.body))
				if getOutcome.err != nil {
					local.Failures++
					localErrs.add(fmt.Sprintf("cleanup GET %s: %v", blobURL, getOutcome.err))
					continue
				}
				if getOutcome.status != http.StatusOK {
					local.Failures++
					localErrs.add(fmt.Sprintf("cleanup GET %s: expected 200, got %d", blobURL, getOutcome.status))
					continue
				}
				if !bytes.Equal(getOutcome.body, payload) {
					local.Failures++
					localErrs.add(fmt.Sprintf("cleanup GET %s: payload mismatch", blobURL))
				}

				verifyOutcome := doRequest(client, cfg, "GET", blobURL, nil)
				local.Requests++
				local.ReceivedBytes += uint64(len(verifyOutcome.body))
				if verifyOutcome.err != nil {
					local.Failures++
					localErrs.add(fmt.Sprintf("cleanup GET %s (404 check): %v", blobURL, verifyOutcome.err))
					continue
				}
				if verifyOutcome.status != http.StatusNotFound {
					local.Failures++
					local.Verify404Misses++
					localErrs.add(fmt.Sprintf("cleanup GET %s (404 check): expected 404, got %d", blobURL, verifyOutcome.status))
					continue
				}
				local.Successes++
			}

			mu.Lock()
			result.Attempts += local.Attempts
			result.Successes += local.Successes
			result.Failures += local.Failures
			result.Requests += local.Requests
			result.SentBytes += local.SentBytes
			result.ReceivedBytes += local.ReceivedBytes
			result.Verify404Misses += local.Verify404Misses
			errs.merge(localErrs.list())
			mu.Unlock()
		}()
	}

	for _, id := range ids {
		idCh <- id
	}
	close(idCh)
	wg.Wait()
	result.WallSeconds = time.Since(start).Seconds()
	result.ErrorSamples = errs.list()
	return result
}

func newHTTPClient(cfg benchConfig, parallelism int) *http.Client {
	if parallelism < 1 {
		parallelism = 1
	}
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: cfg.Timeout, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:          parallelism*4 + 32,
		MaxIdleConnsPerHost:   parallelism*4 + 32,
		MaxConnsPerHost:       parallelism*4 + 32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   cfg.Timeout,
		ResponseHeaderTimeout: cfg.Timeout,
		ExpectContinueTimeout: time.Second,
		DisableCompression:    true,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: cfg.Insecure, //nolint:gosec
			MinVersion:         tls.VersionTLS12,
		},
	}
	return &http.Client{Transport: transport}
}

func closeIdleConnections(client *http.Client) {
	if client == nil || client.Transport == nil {
		return
	}
	if closer, ok := client.Transport.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

func doRequest(client *http.Client, cfg benchConfig, method, url string, body []byte) requestOutcome {
	ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
	defer cancel()

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return requestOutcome{err: err}
	}
	req.Header.Set("User-Agent", cfg.UserAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/octet-stream")
		req.ContentLength = int64(len(body))
	}

	start := time.Now()
	resp, err := client.Do(req)
	latency := time.Since(start)
	if err != nil {
		return requestOutcome{latency: latency, err: err}
	}
	defer resp.Body.Close()

	payload, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return requestOutcome{
			status:  resp.StatusCode,
			proto:   resp.Proto,
			latency: latency,
			err:     readErr,
		}
	}
	return requestOutcome{
		status:  resp.StatusCode,
		body:    payload,
		proto:   resp.Proto,
		latency: latency,
	}
}

func validateStatusPayload(body []byte) error {
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}

	if _, ok := numberField(decoded, "uptime_hours"); !ok {
		return errors.New("status JSON missing numeric field uptime_hours")
	}
	if _, ok := numberField(decoded, "total_served"); !ok {
		return errors.New("status JSON missing numeric field total_served")
	}
	if _, ok := numberField(decoded, "blobs_in_use"); !ok {
		return errors.New("status JSON missing numeric field blobs_in_use")
	}
	if raw, ok := decoded["connections"]; ok {
		obj, ok := raw.(map[string]any)
		if !ok {
			return errors.New("status JSON field connections is not an object")
		}
		for _, key := range []string{"total", "unknown", "debounced"} {
			if _, exists := obj[key]; exists {
				if _, ok := numberField(obj, key); !ok {
					return fmt.Errorf("status JSON field connections.%s is not numeric", key)
				}
			}
		}
	}
	return nil
}

func numberField(m map[string]any, key string) (float64, bool) {
	value, ok := m[key]
	if !ok {
		return 0, false
	}
	switch v := value.(type) {
	case float64:
		return v, true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

func makeBlobID(runSeed uint64, ph phase, processIndex, workerIndex int, seq uint64) [16]byte {
	var id [16]byte
	const phaseStatusTag uint16 = 0x5151
	const phaseWriteTag uint16 = 0x7171
	const phaseE2ETag uint16 = 0x9191

	phaseTag := phaseWriteTag
	switch ph {
	case phaseStatus:
		phaseTag = phaseStatusTag
	case phaseWrite:
		phaseTag = phaseWriteTag
	case phaseE2E:
		phaseTag = phaseE2ETag
	}

	left := splitmix64(runSeed ^ uint64(phaseTag)<<32 ^ uint64(processIndex)<<16 ^ uint64(workerIndex))
	right := (uint64(uint16(processIndex)) << 48) | (uint64(uint16(workerIndex)) << 32) | (seq & 0xFFFFFFFF)
	binary.BigEndian.PutUint64(id[0:8], left)
	binary.BigEndian.PutUint64(id[8:16], right)
	return id
}

func makePayload(id [16]byte, size int) []byte {
	payload := make([]byte, size)
	s0 := binary.BigEndian.Uint64(id[:8])
	s1 := binary.BigEndian.Uint64(id[8:])
	state := splitmix64(s0 ^ 0x9e3779b97f4a7c15)
	state ^= splitmix64(s1 ^ 0xbf58476d1ce4e5b9)
	offset := 0
	for offset < len(payload) {
		state = splitmix64(state)
		var block [8]byte
		binary.LittleEndian.PutUint64(block[:], state)
		offset += copy(payload[offset:], block[:])
	}
	return payload
}

func splitmix64(x uint64) uint64 {
	x += 0x9e3779b97f4a7c15
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
	x = (x ^ (x >> 27)) * 0x94d049bb133111eb
	return x ^ (x >> 31)
}

func mustRandomUint64() uint64 {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	return binary.BigEndian.Uint64(buf[:])
}

func hexString(id [16]byte) string {
	var dst [32]byte
	hex.Encode(dst[:], id[:])
	return string(dst[:])
}

func waitUntil(t time.Time) {
	for {
		now := time.Now()
		if !now.Before(t) {
			return
		}
		sleepFor := t.Sub(now)
		if sleepFor > 20*time.Millisecond {
			sleepFor = 20 * time.Millisecond
		}
		time.Sleep(sleepFor)
	}
}

func shardParallelism(total, parts int) []int {
	shards := make([]int, parts)
	base := total / parts
	remainder := total % parts
	for i := range shards {
		shards[i] = base
		if i < remainder {
			shards[i]++
		}
	}
	return shards
}

func initRunResult(targetURL string, ph phase, parallelism, processes int) runResult {
	return runResult{
		TargetURL:        targetURL,
		Phase:            ph,
		Parallelism:      parallelism,
		Processes:        processes,
		RequestLatency:   newLatencyHistogram(),
		OperationLatency: newLatencyHistogram(),
		StatusLatency:    newLatencyHistogram(),
		PostLatency:      newLatencyHistogram(),
		GetLatency:       newLatencyHistogram(),
		Verify404Latency: newLatencyHistogram(),
		ProtoCounts:      make(map[string]uint64),
	}
}

func mergeInto(dst *runResult, src runResult) {
	dst.Attempts += src.Attempts
	dst.Successes += src.Successes
	dst.Failures += src.Failures
	dst.Requests += src.Requests
	dst.Operations += src.Operations
	dst.SentBytes += src.SentBytes
	dst.ReceivedBytes += src.ReceivedBytes
	dst.RequestLatency.merge(src.RequestLatency)
	dst.OperationLatency.merge(src.OperationLatency)
	dst.StatusLatency.merge(src.StatusLatency)
	dst.PostLatency.merge(src.PostLatency)
	dst.GetLatency.merge(src.GetLatency)
	dst.Verify404Latency.merge(src.Verify404Latency)
	for proto, count := range src.ProtoCounts {
		dst.ProtoCounts[proto] += count
	}
	if src.Cleanup != nil {
		if dst.Cleanup == nil {
			dst.Cleanup = &cleanupResult{}
		}
		dst.Cleanup.Attempts += src.Cleanup.Attempts
		dst.Cleanup.Successes += src.Cleanup.Successes
		dst.Cleanup.Failures += src.Cleanup.Failures
		dst.Cleanup.Requests += src.Cleanup.Requests
		dst.Cleanup.SentBytes += src.Cleanup.SentBytes
		dst.Cleanup.ReceivedBytes += src.Cleanup.ReceivedBytes
		dst.Cleanup.Verify404Misses += src.Cleanup.Verify404Misses
		if src.Cleanup.WallSeconds > dst.Cleanup.WallSeconds {
			dst.Cleanup.WallSeconds = src.Cleanup.WallSeconds
		}
	}
}

func mergeResults(results []runResult, targetURL string, ph phase, parallelism, processes, maxErrorSamples int) runResult {
	merged := initRunResult(targetURL, ph, parallelism, processes)
	errs := newErrorCollector(maxErrorSamples)
	cleanupErrs := newErrorCollector(maxErrorSamples)
	for _, result := range results {
		mergeInto(&merged, result)
		errs.merge(result.ErrorSamples)
		if result.Cleanup != nil {
			cleanupErrs.merge(result.Cleanup.ErrorSamples)
		}
	}
	merged.ErrorSamples = errs.list()
	if merged.Cleanup != nil {
		merged.Cleanup.ErrorSamples = cleanupErrs.list()
	}
	return merged
}

func printResult(result runResult) {
	reqRate := safeRate(result.Requests, result.TimedWallSeconds)
	opRate := safeRate(result.Operations, result.TimedWallSeconds)
	sendRate := safeRateBytes(result.SentBytes, result.TimedWallSeconds)
	recvRate := safeRateBytes(result.ReceivedBytes, result.TimedWallSeconds)
	opStats := result.OperationLatency.stats()
	fmt.Printf(
		"p=%-5d proc=%-3d attempts=%-8d succ=%-8d fail=%-6d req/s=%-10.1f op/s=%-10.1f op-lat=%s send=%s recv=%s proto=%s\n",
		result.Parallelism,
		result.Processes,
		result.Attempts,
		result.Successes,
		result.Failures,
		reqRate,
		opRate,
		formatLatencyStats(opStats),
		formatRate(sendRate),
		formatRate(recvRate),
		formatProtoCounts(result.ProtoCounts),
	)

	switch result.Phase {
	case phaseStatus:
		fmt.Printf("  request-lat=%s\n", formatLatencyStats(result.StatusLatency.stats()))
	case phaseWrite:
		fmt.Printf("  post-lat=%s\n", formatLatencyStats(result.PostLatency.stats()))
	case phaseE2E:
		fmt.Printf("  post-lat=%s | get-lat=%s | 404-lat=%s\n",
			formatLatencyStats(result.PostLatency.stats()),
			formatLatencyStats(result.GetLatency.stats()),
			formatLatencyStats(result.Verify404Latency.stats()),
		)
	}

	if result.Cleanup != nil {
		fmt.Printf("  cleanup attempts=%d succ=%d fail=%d req=%d wall=%s recv=%s\n",
			result.Cleanup.Attempts,
			result.Cleanup.Successes,
			result.Cleanup.Failures,
			result.Cleanup.Requests,
			(time.Duration(result.Cleanup.WallSeconds * float64(time.Second))).Round(time.Millisecond),
			formatRate(safeRateBytes(result.Cleanup.ReceivedBytes, result.Cleanup.WallSeconds)),
		)
		if len(result.Cleanup.ErrorSamples) > 0 {
			fmt.Printf("  cleanup errors:\n")
			for _, sample := range result.Cleanup.ErrorSamples {
				fmt.Printf("    - %s\n", sample)
			}
		}
	}
	if len(result.ErrorSamples) > 0 {
		fmt.Printf("  errors:\n")
		for _, sample := range result.ErrorSamples {
			fmt.Printf("    - %s\n", sample)
		}
	}
}

func safeRate(count uint64, seconds float64) float64 {
	if seconds <= 0 {
		return 0
	}
	return float64(count) / seconds
}

func safeRateBytes(bytes uint64, seconds float64) float64 {
	if seconds <= 0 {
		return 0
	}
	return float64(bytes) / seconds
}

func formatLatencyStats(stats latencyStats) string {
	if stats.Count == 0 {
		return "n/a"
	}
	return fmt.Sprintf("avg=%s p50=%s p90=%s p99=%s", formatDuration(stats.Avg), formatDuration(stats.P50), formatDuration(stats.P90), formatDuration(stats.P99))
}

func formatDuration(d time.Duration) string {
	switch {
	case d >= time.Second:
		return fmt.Sprintf("%.2fs", d.Seconds())
	case d >= time.Millisecond:
		return fmt.Sprintf("%.2fms", float64(d)/float64(time.Millisecond))
	default:
		return fmt.Sprintf("%.0fµs", float64(d)/float64(time.Microsecond))
	}
}

func formatRate(bytesPerSecond float64) string {
	const (
		kib = 1024.0
		mib = 1024.0 * 1024.0
		gib = 1024.0 * 1024.0 * 1024.0
	)
	switch {
	case bytesPerSecond >= gib:
		return fmt.Sprintf("%.2fGiB/s", bytesPerSecond/gib)
	case bytesPerSecond >= mib:
		return fmt.Sprintf("%.2fMiB/s", bytesPerSecond/mib)
	case bytesPerSecond >= kib:
		return fmt.Sprintf("%.2fKiB/s", bytesPerSecond/kib)
	default:
		return fmt.Sprintf("%.0fB/s", bytesPerSecond)
	}
}

func formatProtoCounts(counts map[string]uint64) string {
	if len(counts) == 0 {
		return "-"
	}
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s=%d", key, counts[key]))
	}
	return strings.Join(parts, ",")
}

func formatPhases(phases []phase) string {
	parts := make([]string, 0, len(phases))
	for _, ph := range phases {
		parts = append(parts, string(ph))
	}
	return strings.Join(parts, ",")
}

func formatIntList(values []int) string {
	parts := make([]string, 0, len(values))
	for _, v := range values {
		parts = append(parts, strconv.Itoa(v))
	}
	return strings.Join(parts, ",")
}

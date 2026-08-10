package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

const (
	maxDNSRequestBytes = 4096
	maxDNSCNAMEHops    = 8
	maxDNSConnections  = 128
	dnsUpstreamTimeout = 3 * time.Second
)

type dnsExchangeFunc func(context.Context, []byte) ([]byte, error)

// egressDNSServer is the only DNS resolver managed guests may reach. It strips
// unvalidated authority/additional data, validates an entire CNAME/address set,
// and only then installs TTL-bound destination addresses in the machine's
// private ipset. The firewall blocks direct DNS and DNS-over-TLS forwarding.
type egressDNSServer struct {
	cfg        Config
	mgr        *Manager
	controller *egressController
	exchange   dnsExchangeFunc

	udp       net.PacketConn
	tcp       net.Listener
	closed    chan struct{}
	closeOnce sync.Once
	wg        sync.WaitGroup
	sem       chan struct{}
}

func newEgressDNSServer(cfg Config, mgr *Manager, controller *egressController) *egressDNSServer {
	server := &egressDNSServer{
		cfg:        cfg,
		mgr:        mgr,
		controller: controller,
		closed:     make(chan struct{}),
		sem:        make(chan struct{}, maxDNSConnections),
	}
	server.exchange = server.exchangeUpstream
	return server
}

func (mgr *Manager) StartManagedEgressDNS() (*egressDNSServer, error) {
	if !mgr.cfg.NehemiahMode || !mgr.cfg.NetEnable {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), dnsUpstreamTimeout)
	err := mgr.egress.refreshHardFloor(ctx)
	cancel()
	if err != nil {
		return nil, fmt.Errorf("initialize managed egress deny floor: %w", err)
	}
	server := newEgressDNSServer(mgr.cfg, mgr, mgr.egress)
	if err := server.Start(); err != nil {
		return nil, err
	}
	return server, nil
}

func (server *egressDNSServer) Start() error {
	udp, err := net.ListenPacket("udp4", server.cfg.egressDNSListen())
	if err != nil {
		return fmt.Errorf("listen for managed UDP DNS on %s: %w", server.cfg.egressDNSListen(), err)
	}
	tcp, err := net.Listen("tcp4", server.cfg.egressDNSListen())
	if err != nil {
		_ = udp.Close()
		return fmt.Errorf("listen for managed TCP DNS on %s: %w", server.cfg.egressDNSListen(), err)
	}
	server.udp = udp
	server.tcp = tcp
	server.wg.Add(3)
	go server.serveUDP()
	go server.serveTCP()
	go server.refreshHardFloor()
	return nil
}

func (server *egressDNSServer) Close() error {
	var first error
	server.closeOnce.Do(func() {
		close(server.closed)
		if server.udp != nil {
			first = server.udp.Close()
		}
		if server.tcp != nil {
			if err := server.tcp.Close(); first == nil {
				first = err
			}
		}
	})
	server.wg.Wait()
	return first
}

func (server *egressDNSServer) refreshHardFloor() {
	defer server.wg.Done()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-server.closed:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), dnsUpstreamTimeout)
			if err := server.controller.refreshHardFloor(ctx); err != nil {
				logManagedHostEvent(managedHostEventEgressFloorRefreshFailed, managedHostLogFields{Err: err})
			}
			cancel()
		}
	}
}

func (server *egressDNSServer) serveUDP() {
	defer server.wg.Done()
	buffer := make([]byte, maxDNSRequestBytes+1)
	for {
		n, source, err := server.udp.ReadFrom(buffer)
		if err != nil {
			select {
			case <-server.closed:
				return
			default:
				continue
			}
		}
		request := append([]byte(nil), buffer[:n]...)
		select {
		case server.sem <- struct{}{}:
			server.wg.Add(1)
			go func() {
				defer server.wg.Done()
				defer func() { <-server.sem }()
				response := server.handle(request, addressFromNetAddr(source))
				if len(response) != 0 {
					_, _ = server.udp.WriteTo(response, source)
				}
			}()
		default:
			response := dnsErrorResponse(request, dnsmessage.RCodeServerFailure)
			if len(response) != 0 {
				_, _ = server.udp.WriteTo(response, source)
			}
		}
	}
}

func (server *egressDNSServer) serveTCP() {
	defer server.wg.Done()
	for {
		connection, err := server.tcp.Accept()
		if err != nil {
			select {
			case <-server.closed:
				return
			default:
				continue
			}
		}
		select {
		case server.sem <- struct{}{}:
			server.wg.Add(1)
			go func() {
				defer server.wg.Done()
				defer func() { <-server.sem }()
				server.handleTCP(connection)
			}()
		default:
			_ = connection.Close()
		}
	}
}

func (server *egressDNSServer) handleTCP(connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
	for requests := 0; requests < 16; requests++ {
		var size [2]byte
		if _, err := io.ReadFull(connection, size[:]); err != nil {
			return
		}
		length := int(binary.BigEndian.Uint16(size[:]))
		if length < 12 || length > maxDNSRequestBytes {
			return
		}
		request := make([]byte, length)
		if _, err := io.ReadFull(connection, request); err != nil {
			return
		}
		response := server.handle(request, addressFromNetAddr(connection.RemoteAddr()))
		if len(response) == 0 || len(response) > 65535 {
			return
		}
		binary.BigEndian.PutUint16(size[:], uint16(len(response)))
		if err := writeDNSBytes(connection, append(size[:], response...)); err != nil {
			return
		}
	}
}

func addressFromNetAddr(address net.Addr) netip.Addr {
	switch typed := address.(type) {
	case *net.UDPAddr:
		if parsed, ok := netip.AddrFromSlice(typed.IP); ok {
			return parsed.Unmap()
		}
	case *net.TCPAddr:
		if parsed, ok := netip.AddrFromSlice(typed.IP); ok {
			return parsed.Unmap()
		}
	}
	return netip.Addr{}
}

func (server *egressDNSServer) handle(raw []byte, source netip.Addr) []byte {
	var request dnsmessage.Message
	if len(raw) > maxDNSRequestBytes || request.Unpack(raw) != nil || request.Response || request.OpCode != 0 || request.RCode != dnsmessage.RCodeSuccess || len(request.Questions) != 1 || len(request.Answers) != 0 || len(request.Authorities) != 0 {
		return dnsErrorResponse(raw, dnsmessage.RCodeFormatError)
	}
	question := request.Questions[0]
	if question.Class != dnsmessage.ClassINET || (question.Type != dnsmessage.TypeA && question.Type != dnsmessage.TypeAAAA) {
		return dnsErrorResponse(raw, dnsmessage.RCodeNotImplemented)
	}
	hostname, err := normalizeDNSName(question.Name.String())
	if err != nil {
		return dnsErrorResponse(raw, dnsmessage.RCodeNameError)
	}
	machineID, ok := server.mgr.machineForGuestAddress(source)
	if !ok {
		return dnsErrorResponse(raw, dnsmessage.RCodeRefused)
	}
	policy, ok := server.controller.policyForMachine(machineID)
	hostnameRule := ok && policy.allowsHostname(hostname)
	cidrResolution := ok && !hostnameRule && len(policy.cidrs) != 0 && question.Type == dnsmessage.TypeA
	if !hostnameRule && !cidrResolution {
		return dnsErrorResponse(raw, dnsmessage.RCodeRefused)
	}
	// Forward only the validated question. Guest-controlled additional records
	// (including arbitrary EDNS options) must not become a DNS exfiltration or
	// upstream cache-poisoning side channel.
	upstreamRequest, err := (&dnsmessage.Message{
		Header:    dnsmessage.Header{ID: request.ID, RecursionDesired: true},
		Questions: []dnsmessage.Question{question},
	}).Pack()
	if err != nil {
		return dnsErrorResponse(raw, dnsmessage.RCodeFormatError)
	}
	ctx, cancel := context.WithTimeout(context.Background(), dnsUpstreamTimeout)
	responseBytes, err := server.exchange(ctx, upstreamRequest)
	cancel()
	if err != nil {
		return dnsErrorResponse(raw, dnsmessage.RCodeServerFailure)
	}
	validated, learned, err := server.validateResponse(request, responseBytes)
	if err != nil {
		return dnsErrorResponse(raw, dnsmessage.RCodeServerFailure)
	}
	// Managed IPv6 remains disabled and host-wide dropped. AAAA is sanitized and
	// returned for normal resolver behavior but never opens an IPv6 egress rule.
	if question.Type == dnsmessage.TypeA && len(learned) != 0 {
		if hostnameRule {
			if err := server.controller.learn(machineID, hostname, learned); err != nil {
				return dnsErrorResponse(raw, dnsmessage.RCodeServerFailure)
			}
		} else {
			// CIDR-only policies may use ordinary DNS names, but every terminal
			// answer must already fit the explicit network authorization. DNS never
			// expands the firewall set in this mode.
			for _, learnedAddress := range learned {
				if !policy.allowsCIDRAddress(learnedAddress.address) {
					return dnsErrorResponse(raw, dnsmessage.RCodeRefused)
				}
			}
		}
	}
	packed, err := validated.Pack()
	if err != nil {
		return dnsErrorResponse(raw, dnsmessage.RCodeServerFailure)
	}
	return packed
}

func (controller *egressController) policyForMachine(machineID string) (managedEgressPolicy, bool) {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	installed, ok := controller.installed[machineID]
	return installed.policy, ok
}

func (mgr *Manager) machineForGuestAddress(source netip.Addr) (string, bool) {
	if !source.IsValid() || !source.Is4() {
		return "", false
	}
	subnet, err := netip.ParsePrefix(mgr.cfg.NetSubnet + ".0/24")
	if err != nil || !subnet.Contains(source) || source == subnet.Addr() || source == netip.MustParseAddr(mgr.cfg.NetSubnet+".1") || source == netip.MustParseAddr(mgr.cfg.NetSubnet+".255") {
		return "", false
	}
	type candidate struct {
		id string
		ip string
	}
	mgr.mu.Lock()
	candidates := make([]candidate, 0, len(mgr.machines))
	for _, machine := range mgr.machines {
		if machine.driver != nil && machine.driver.network && machine.driver.tap == tapName(machine.ID) {
			candidates = append(candidates, candidate{id: machine.ID, ip: machine.driver.ip})
		}
	}
	mgr.mu.Unlock()
	for _, candidate := range candidates {
		if candidate.ip != "" {
			if candidate.ip == source.String() {
				return candidate.id, true
			}
			continue
		}
		leased, ok := guestIP(candidate.id, mgr.cfg.LeasesPath)
		if ok && leased == source.String() {
			// Cache the DHCP identity for subsequent packets. State persistence is
			// intentionally left to the normal lifecycle transition path.
			mgr.mu.Lock()
			if current := mgr.machines[candidate.id]; current != nil && current.driver != nil && current.driver.ip == "" {
				current.driver.ip = leased
			}
			mgr.mu.Unlock()
			return candidate.id, true
		}
	}
	return "", false
}

func (server *egressDNSServer) exchangeUpstream(ctx context.Context, request []byte) ([]byte, error) {
	dialer := net.Dialer{}
	connection, err := dialer.DialContext(ctx, "udp", server.cfg.egressDNSUpstream())
	if err != nil {
		return nil, err
	}
	deadline, ok := ctx.Deadline()
	if ok {
		_ = connection.SetDeadline(deadline)
	}
	written, err := connection.Write(request)
	if err != nil || written != len(request) {
		_ = connection.Close()
		if err == nil {
			err = io.ErrShortWrite
		}
		return nil, fmt.Errorf("send upstream UDP DNS request: wrote %d/%d: %w", written, len(request), err)
	}
	buffer := make([]byte, 65535)
	n, err := connection.Read(buffer)
	_ = connection.Close()
	if err != nil {
		return nil, err
	}
	response := append([]byte(nil), buffer[:n]...)
	var parsed dnsmessage.Message
	if parsed.Unpack(response) != nil || !parsed.Truncated {
		return response, nil
	}

	connection, err = dialer.DialContext(ctx, "tcp", server.cfg.egressDNSUpstream())
	if err != nil {
		return nil, err
	}
	defer connection.Close()
	if ok {
		_ = connection.SetDeadline(deadline)
	}
	if len(request) > 65535 {
		return nil, errors.New("DNS request exceeds TCP framing")
	}
	framed := make([]byte, len(request)+2)
	binary.BigEndian.PutUint16(framed[:2], uint16(len(request)))
	copy(framed[2:], request)
	if err := writeDNSBytes(connection, framed); err != nil {
		return nil, err
	}
	if _, err := io.ReadFull(connection, framed[:2]); err != nil {
		return nil, err
	}
	length := int(binary.BigEndian.Uint16(framed[:2]))
	if length < 12 {
		return nil, errors.New("short upstream TCP DNS response")
	}
	response = make([]byte, length)
	if _, err := io.ReadFull(connection, response); err != nil {
		return nil, err
	}
	return response, nil
}

func (server *egressDNSServer) validateResponse(request dnsmessage.Message, raw []byte) (dnsmessage.Message, []dnsLearnedAddress, error) {
	var response dnsmessage.Message
	if err := response.Unpack(raw); err != nil {
		return dnsmessage.Message{}, nil, err
	}
	if !response.Response || response.ID != request.ID || response.OpCode != request.OpCode || len(response.Questions) != 1 || !sameDNSQuestion(response.Questions[0], request.Questions[0]) {
		return dnsmessage.Message{}, nil, errors.New("upstream DNS response does not match the request")
	}
	sanitized := dnsmessage.Message{Header: response.Header, Questions: append([]dnsmessage.Question(nil), request.Questions...)}
	sanitized.Truncated = false
	sanitized.AuthenticData = false
	sanitized.CheckingDisabled = false
	if response.RCode != dnsmessage.RCodeSuccess {
		return sanitized, nil, nil
	}

	type cnameRecord struct {
		resource dnsmessage.Resource
		target   string
	}
	cnames := make(map[string]cnameRecord)
	addresses := make(map[string][]dnsmessage.Resource)
	for _, resource := range response.Answers {
		owner, err := normalizeDNSName(resource.Header.Name.String())
		if err != nil || resource.Header.Class != dnsmessage.ClassINET {
			return dnsmessage.Message{}, nil, errors.New("upstream DNS answer contains an invalid owner")
		}
		switch body := resource.Body.(type) {
		case *dnsmessage.CNAMEResource:
			target, err := normalizeDNSName(body.CNAME.String())
			if err != nil {
				return dnsmessage.Message{}, nil, errors.New("upstream DNS answer contains an invalid CNAME")
			}
			if _, duplicate := cnames[owner]; duplicate {
				return dnsmessage.Message{}, nil, errors.New("upstream DNS answer contains multiple CNAME targets")
			}
			cnames[owner] = cnameRecord{resource: resource, target: target}
		case *dnsmessage.AResource:
			if request.Questions[0].Type != dnsmessage.TypeA {
				return dnsmessage.Message{}, nil, errors.New("upstream DNS response mixes address families")
			}
			addresses[owner] = append(addresses[owner], resource)
		case *dnsmessage.AAAAResource:
			if request.Questions[0].Type != dnsmessage.TypeAAAA {
				return dnsmessage.Message{}, nil, errors.New("upstream DNS response mixes address families")
			}
			addresses[owner] = append(addresses[owner], resource)
		default:
			return dnsmessage.Message{}, nil, fmt.Errorf("unsupported DNS answer type %d", resource.Header.Type)
		}
	}

	current, _ := normalizeDNSName(request.Questions[0].Name.String())
	visited := make(map[string]struct{}, maxDNSCNAMEHops+1)
	chainTTL := egressMaxTTL
	usedCNAMEs := make(map[string]struct{})
	for hops := 0; ; hops++ {
		if _, duplicate := visited[current]; duplicate {
			return dnsmessage.Message{}, nil, errors.New("upstream DNS response contains a CNAME loop")
		}
		visited[current] = struct{}{}
		record, ok := cnames[current]
		if !ok {
			break
		}
		if hops >= maxDNSCNAMEHops {
			return dnsmessage.Message{}, nil, errors.New("upstream DNS response exceeds the CNAME hop limit")
		}
		usedCNAMEs[current] = struct{}{}
		record.resource.Header.TTL = clampedDNSSeconds(record.resource.Header.TTL)
		if ttl := time.Duration(record.resource.Header.TTL) * time.Second; ttl < chainTTL {
			chainTTL = ttl
		}
		sanitized.Answers = append(sanitized.Answers, record.resource)
		current = record.target
	}
	if len(usedCNAMEs) != len(cnames) {
		return dnsmessage.Message{}, nil, errors.New("upstream DNS response contains an unrelated CNAME")
	}
	for owner := range addresses {
		if owner != current {
			return dnsmessage.Message{}, nil, errors.New("upstream DNS response contains an unrelated address")
		}
	}

	terminal := addresses[current]
	learned := make([]dnsLearnedAddress, 0, len(terminal))
	for _, resource := range terminal {
		address, err := addressFromDNSResource(resource)
		if err != nil || server.controller.isHardDenied(address) {
			return dnsmessage.Message{}, nil, fmt.Errorf("upstream DNS response contains a hard-denied address %q", address)
		}
		resource.Header.TTL = clampedDNSSeconds(resource.Header.TTL)
		ttl := time.Duration(resource.Header.TTL) * time.Second
		if chainTTL < ttl {
			ttl = chainTTL
		}
		resource.Header.TTL = uint32(ttl / time.Second)
		sanitized.Answers = append(sanitized.Answers, resource)
		learned = append(learned, dnsLearnedAddress{address: address, ttl: ttl})
	}
	return sanitized, learned, nil
}

func sameDNSQuestion(left, right dnsmessage.Question) bool {
	leftName, leftErr := normalizeDNSName(left.Name.String())
	rightName, rightErr := normalizeDNSName(right.Name.String())
	return leftErr == nil && rightErr == nil && leftName == rightName && left.Type == right.Type && left.Class == right.Class
}

func addressFromDNSResource(resource dnsmessage.Resource) (netip.Addr, error) {
	switch body := resource.Body.(type) {
	case *dnsmessage.AResource:
		return netip.AddrFrom4(body.A), nil
	case *dnsmessage.AAAAResource:
		return netip.AddrFrom16(body.AAAA).Unmap(), nil
	default:
		return netip.Addr{}, errors.New("DNS resource is not an address")
	}
}

func clampedDNSSeconds(ttl uint32) uint32 {
	return uint32(clampEgressTTL(time.Duration(ttl)*time.Second) / time.Second)
}

func dnsErrorResponse(raw []byte, code dnsmessage.RCode) []byte {
	var request dnsmessage.Message
	_ = request.Unpack(raw)
	id := request.ID
	if len(raw) >= 2 {
		id = binary.BigEndian.Uint16(raw[:2])
	}
	questions := request.Questions
	if len(questions) > 1 {
		questions = nil
	}
	response := dnsmessage.Message{
		Header: dnsmessage.Header{
			ID:                 id,
			Response:           true,
			RecursionDesired:   request.RecursionDesired,
			RecursionAvailable: true,
			RCode:              code,
		},
		Questions: questions,
	}
	packed, _ := response.Pack()
	return packed
}

func writeDNSBytes(writer io.Writer, payload []byte) error {
	for len(payload) != 0 {
		written, err := writer.Write(payload)
		if err != nil {
			return err
		}
		if written <= 0 {
			return io.ErrUnexpectedEOF
		}
		payload = payload[written:]
	}
	return nil
}

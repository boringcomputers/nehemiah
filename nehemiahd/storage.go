package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Storage is the local/self-hosted persistent-volume layer, backed by an
// S3-compatible object store. Managed release policy keeps this layer disabled.
// A "volume" is a prefix in one bucket: vol-<id>/.volume.json holds metadata and
// vol-<id>/f/<path> holds files. No database — volumes are addressed by an
// unguessable id (like shared machines), size-capped, and GC'd on a TTL. When
// accounts land later, ownership is layered on top without moving the data.

var ErrVolumeNotFound = errors.New("volume not found")
var ErrQuotaExceeded = errors.New("volume is full")

type Storage struct {
	client     *minio.Client
	bucket     string
	quotaBytes int64
}

// VolumeMeta is the JSON stored at vol-<id>/.volume.json.
type VolumeMeta struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	QuotaMB   int       `json:"quota_mb"`
}

func newStorage(cfg Config) (*Storage, error) {
	if cfg.S3Endpoint == "" {
		return nil, nil // storage disabled
	}
	cl, err := minio.New(cfg.S3Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.S3Key, cfg.S3Secret, ""),
		Secure: cfg.S3UseSSL,
		Region: cfg.S3Region,
	})
	if err != nil {
		return nil, fmt.Errorf("s3 client: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	exists, err := cl.BucketExists(ctx, cfg.S3Bucket)
	if err != nil {
		return nil, fmt.Errorf("s3 reach: %w", err)
	}
	if !exists {
		if err := cl.MakeBucket(ctx, cfg.S3Bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("s3 make bucket: %w", err)
		}
	}
	return &Storage{client: cl, bucket: cfg.S3Bucket, quotaBytes: int64(cfg.VolumeQuotaMB) << 20}, nil
}

func prefix(id string) string  { return id + "/" }
func metaKey(id string) string { return id + "/.volume.json" }
func fileKey(id, p string) string {
	p = strings.TrimPrefix(p, "/")
	cleaned := path.Clean(p)
	// Collapse only genuine traversal (matching validVolumePath) so legitimate
	// dot-prefixed filenames like ".." + "bashrc" keep their real key instead of
	// all colliding on "_".
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") || strings.Contains(cleaned, "/../") {
		cleaned = "_"
	}
	return id + "/f/" + cleaned
}

// Create writes a new volume marker and returns its metadata.
func (s *Storage) Create(id string, ttl time.Duration) (*VolumeMeta, error) {
	now := time.Now()
	m := &VolumeMeta{ID: id, CreatedAt: now, ExpiresAt: now.Add(ttl), QuotaMB: int(s.quotaBytes >> 20)}
	return m, s.putMeta(m)
}

func (s *Storage) putMeta(m *VolumeMeta) error {
	buf, _ := json.Marshal(m)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	_, err := s.client.PutObject(ctx, s.bucket, metaKey(m.ID), bytes.NewReader(buf), int64(len(buf)),
		minio.PutObjectOptions{ContentType: "application/json"})
	return err
}

// Get returns a volume's metadata, or ErrVolumeNotFound.
func (s *Storage) Get(id string) (*VolumeMeta, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	obj, err := s.client.GetObject(ctx, s.bucket, metaKey(id), minio.GetObjectOptions{})
	if err != nil {
		return nil, ErrVolumeNotFound
	}
	defer obj.Close()
	data, err := io.ReadAll(obj)
	if err != nil || len(data) == 0 {
		return nil, ErrVolumeNotFound
	}
	var m VolumeMeta
	if json.Unmarshal(data, &m) != nil {
		return nil, ErrVolumeNotFound
	}
	return &m, nil
}

// VolumeFile is one stored file.
type VolumeFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// ListFiles enumerates the files in a volume and their total size.
func (s *Storage) ListFiles(id string) ([]VolumeFile, int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	fpref := id + "/f/"
	var files []VolumeFile
	var total int64
	for o := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: fpref, Recursive: true}) {
		if o.Err != nil {
			return nil, 0, o.Err
		}
		files = append(files, VolumeFile{Path: strings.TrimPrefix(o.Key, fpref), Size: o.Size})
		total += o.Size
	}
	return files, total, nil
}

// PutFile stores a file, enforcing the per-volume quota.
func (s *Storage) PutFile(id, p string, r io.Reader, size int64) error {
	_, used, err := s.ListFiles(id)
	if err != nil {
		return err
	}
	if size >= 0 && used+size > s.quotaBytes {
		return ErrQuotaExceeded
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	// size -1 streams with an upper part-size bound; also guards the quota.
	if size < 0 {
		size = -1
	}
	_, err = s.client.PutObject(ctx, s.bucket, fileKey(id, p), r, size,
		minio.PutObjectOptions{ContentType: "application/octet-stream"})
	return err
}

// GetFile opens a file for reading; caller closes it.
func (s *Storage) GetFile(id, p string) (io.ReadCloser, error) {
	ctx := context.Background()
	obj, err := s.client.GetObject(ctx, s.bucket, fileKey(id, p), minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	// Probe existence (GetObject is lazy).
	if _, err := obj.Stat(); err != nil {
		obj.Close()
		return nil, ErrVolumeNotFound
	}
	return obj, nil
}

// DeleteFile removes one file.
func (s *Storage) DeleteFile(id, p string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	return s.client.RemoveObject(ctx, s.bucket, fileKey(id, p), minio.RemoveObjectOptions{})
}

// Delete removes an entire volume (marker + all files).
func (s *Storage) Delete(id string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	objectsCh := make(chan minio.ObjectInfo)
	go func() {
		defer close(objectsCh)
		for o := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix(id), Recursive: true}) {
			if o.Err == nil {
				objectsCh <- o
			}
		}
	}()
	for e := range s.client.RemoveObjects(ctx, s.bucket, objectsCh, minio.RemoveObjectsOptions{}) {
		if e.Err != nil {
			return e.Err
		}
	}
	return nil
}

// GCExpired deletes volumes whose TTL has passed. Returns the count removed.
func (s *Storage) GCExpired() int {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	now := time.Now()
	var expired []string
	for o := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Recursive: true}) {
		if o.Err != nil || !strings.HasSuffix(o.Key, "/.volume.json") {
			continue
		}
		id := strings.TrimSuffix(o.Key, "/.volume.json")
		if m, err := s.Get(id); err == nil && now.After(m.ExpiresAt) {
			expired = append(expired, id)
		}
	}
	n := 0
	for _, id := range expired {
		if s.Delete(id) == nil {
			n++
		}
	}
	return n
}

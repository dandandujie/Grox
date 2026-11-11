package service

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

func canonicalPackageDocument(document map[string]any) ([]byte, error) {
	copy := make(map[string]any, len(document))
	for key, value := range document {
		if key == "signature" || key == "publicKey" || key == "signedAt" {
			continue
		}
		copy[key] = value
	}
	return json.Marshal(copy)
}

func (s *Service) signPackageDocument(document map[string]any) error {
	private, err := s.teamSigningKeyLocked()
	if err != nil {
		return err
	}
	payload, err := canonicalPackageDocument(document)
	if err != nil {
		return err
	}
	document["signature"] = base64.StdEncoding.EncodeToString(ed25519.Sign(private, payload))
	document["publicKey"] = base64.StdEncoding.EncodeToString(private.Public().(ed25519.PublicKey))
	document["signedAt"] = time.Now().UTC().Format(time.RFC3339)
	return nil
}

func verifyPackageDocument(document map[string]any) error {
	signature, _ := document["signature"].(string)
	publicKey, _ := document["publicKey"].(string)
	if signature == "" && publicKey == "" {
		return nil
	}
	if signature == "" || publicKey == "" {
		return fmt.Errorf("package signature is incomplete")
	}
	key, err := base64.StdEncoding.DecodeString(publicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return fmt.Errorf("package public key is invalid")
	}
	sig, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("package signature is invalid")
	}
	payload, err := canonicalPackageDocument(document)
	if err != nil {
		return err
	}
	if !ed25519.Verify(ed25519.PublicKey(key), payload, sig) {
		return fmt.Errorf("package signature does not match")
	}
	return nil
}

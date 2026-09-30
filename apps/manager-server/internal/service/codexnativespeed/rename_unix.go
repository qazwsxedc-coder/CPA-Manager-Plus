//go:build !windows

package codexnativespeed

import (
	"os"

	"golang.org/x/sys/unix"
)

// Go 1.24 has os.Root but no Root.Rename. Anchor both names to the opened
// directory so publication cannot follow a swapped parent path.
func renameWithinRoot(root *os.Root, old, next string) error {
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	return unix.Renameat(int(dir.Fd()), old, int(dir.Fd()), next)
}

package codexnativespeed

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

type fileRenameInformation struct {
	ReplaceIfExists uint32
	RootDirectory   windows.Handle
	FileNameLength  uint32
	FileName        [1]uint16
}

// Use the opened directory's handle instead of resolving its path again.
func renameWithinRoot(root *os.Root, old, next string) error {
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	objectName, err := windows.NewNTUnicodeString(old)
	if err != nil {
		return err
	}
	attrs := &windows.OBJECT_ATTRIBUTES{
		RootDirectory: windows.Handle(dir.Fd()), ObjectName: objectName,
		Attributes: windows.OBJ_CASE_INSENSITIVE,
	}
	attrs.Length = uint32(unsafe.Sizeof(*attrs))
	var handle windows.Handle
	var ioStatus windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(&handle, windows.SYNCHRONIZE|windows.DELETE, attrs, &ioStatus, nil, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, windows.FILE_OPEN,
		windows.FILE_OPEN_REPARSE_POINT|windows.FILE_OPEN_FOR_BACKUP_INTENT|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	name, err := windows.UTF16FromString(next)
	if err != nil {
		return err
	}
	nameLen := (len(name) - 1) * 2
	var info fileRenameInformation
	size := int(unsafe.Offsetof(info.FileName)) + nameLen
	buffer := make([]byte, size)
	rename := (*fileRenameInformation)(unsafe.Pointer(&buffer[0]))
	rename.ReplaceIfExists = windows.FILE_RENAME_REPLACE_IF_EXISTS
	rename.RootDirectory = windows.Handle(dir.Fd())
	rename.FileNameLength = uint32(nameLen)
	copy(unsafe.Slice(&rename.FileName[0], len(name)-1), name[:len(name)-1])
	return windows.NtSetInformationFile(handle, &ioStatus, &buffer[0], uint32(size), windows.FileRenameInformation)
}

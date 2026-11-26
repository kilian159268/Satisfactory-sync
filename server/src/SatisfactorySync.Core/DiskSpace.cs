namespace SatisfactorySync.Core;

public interface IDiskSpace
{
    long AvailableBytes(string path);
}

public sealed class DriveDiskSpace : IDiskSpace
{
    public long AvailableBytes(string path) => new DriveInfo(Path.GetFullPath(path)).AvailableFreeSpace;
}

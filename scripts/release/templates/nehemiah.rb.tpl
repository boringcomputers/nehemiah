class Nehemiah < Formula
  desc "Command-line client for Boring Computers Cloud and Nehemiah"
  homepage "https://github.com/@@REPOSITORY@@"
  url "https://github.com/@@REPOSITORY@@/releases/download/v@@VERSION@@/nehemiah-cli-@@VERSION@@.tgz"
  version "@@VERSION@@"
  sha256 "@@SHA256@@"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match "Boring Computers", shell_output("#{bin}/bc help")
  end
end

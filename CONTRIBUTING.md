# Contributing to TrustLend

First off, thank you for considering contributing to TrustLend! It's people like you that make TrustLend such a great tool.

## Where do I go from here?

If you've noticed a bug or have a feature request, make one! It's generally best if you get confirmation of your bug or approval for your feature request this way before starting to code.

## Fork & create a branch

If this is something you think you can fix, then fork TrustLend and create a branch with a descriptive name.

A good branch name would be (where issue #325 is the ticket you're working on):

```sh
git checkout -b 325-add-stellar-wallet-support
```

## Setup Local Development

**Option 1: Node.js (Standard)**
Make sure you have Node.js and npm installed.
```sh
npm install
npm run dev
```

**Option 2: Docker Compose (Easier)**
If you prefer not to install dependencies locally, just use Docker:
```sh
docker-compose up
```

Ensure everything works correctly on your local machine at `http://localhost:3000`.

## Implement your fix or feature

At this point, you're ready to make your changes. Feel free to ask for help; everyone is a beginner at first.

## Make a Pull Request

At this point, you should switch back to your master branch and make sure it's up to date with TrustLend's master branch:

```sh
git remote add upstream git@github.com:thisisouvik/trustlend-stellar.git
git checkout master
git pull upstream master
```

Then update your feature branch from your local copy of master, and push it!

```sh
git checkout 325-add-stellar-wallet-support
git rebase master
git push --set-upstream origin 325-add-stellar-wallet-support
```

Finally, go to GitHub and make a Pull Request.

## Keeping your Pull Request updated

If a maintainer asks you to "rebase" your PR, they're saying that a lot of code has changed, and that you need to update your branch so it's easier to merge.

## Merging A PR (maintainers only)

A PR can only be merged into master by a maintainer if:

* It is passing CI.
* It has been approved by at least one maintainer.
* It has no requested changes.
* It is up to date with current master.
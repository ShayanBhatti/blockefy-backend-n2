// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Blockefy
 * @notice A decentralized escrow smart contract for the Blockefy freelancing platform.
 *
 * @dev This contract manages the entire lifecycle of a freelance gig/project between a
 *      Client (buyer) and a Freelancer (seller) using native ETH (on a testnet for now).
 *
 *      --- HIGH-LEVEL FLOW ---
 *      1. CLIENT creates a project with a type: "FixClaim" (one-time payment) or
 *         "Milestones" (multiple milestone-based payments).
 *      2. FREELANCER submits a proposal (off-chain) with payment details. Once the
 *         CLIENT approves that proposal, the project is officially CREATED on-chain
 *         and the freelancer is assigned.
 *      3. For a Milestones project, the FREELANCER creates milestones (as many as
 *         needed) with their individual amounts.
 *      4. CLIENT deposits ETH into the contract as escrow (the fix claim amount, or
 *         the first milestone payment).
 *      5. FREELANCER completes a milestone and marks it complete. The CLIENT then
 *         reviews the delivered work:
 *            - "No changes required"  -> payment is released to the freelancer.
 *            - "Changes required"     -> a review window is granted and the deadline
 *                                          is extended automatically.
 *      6. If the CLIENT does NOT review within the auto-review window, the payment is
 *         released to the freelancer automatically (time-based safeguard).
 *      7. Milestones are paid in strict SEQUENTIAL order (1 -> 2 -> 3 ...). A milestone
 *         cannot be claimed until all previous milestones are claimed.
 *      8. If the project deadline passes, the CLIENT may either extend the deadline or
 *         retrieve their escrowed funds (refund).
 *      9. An ADMIN can only be invoked for DISPUTES (unlock stuck funds), never for
 *         day-to-day project management.
 *
 *      NOTE: Platform fees are currently 0%. The contract is structured so a 2%
 *            platform fee can be enabled later via setPlatformFee().
 */

// -----------------------------------------------------------------------------
//  Import: OpenZeppelin's ReentrancyGuard & Ownable
// -----------------------------------------------------------------------------
//  ReentrancyGuard protects our payable functions from reentrancy attacks
//  (a malicious contract calling back into us while we are sending ETH).
//  Ownable gives us the owner (deployer) address which acts as the ADMIN.
//
//  NOTE: These paths match OpenZeppelin v5 (the default version Remix uses).
//        v5 changed `Ownable()` to require an initial owner (msg.sender) and
//        moved ReentrancyGuard from `security/` to `utils/`.
// -----------------------------------------------------------------------------
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Blockefy is ReentrancyGuard, Ownable {
    // =========================================================================
    //  STATE VARIABLES
    // =========================================================================

    /// @notice Project statuses used throughout the contract lifecycle.
    enum ProjectStatus {
        Created,      // 0 - project exists but no proposal approved yet (or after approval, before funding)
        Funded,       // 1 - client has deposited ETH into escrow
        InProgress,   // 2 - work is actively being delivered/reviewed
        Completed,    // 3 - all payments released, project done
        Cancelled,    // 4 - client got a refund / project abandoned
        Disputed      // 5 - admin has locked the project for dispute resolution
    }

    /// @notice The type of payment model a project uses.
    enum ProjectType {
        FixClaim,     // 0 - one-time, single payment for the whole project
        Milestones    // 1 - multiple sequential milestone payments
    }

    /// @notice Holds the details of a single milestone within a project.
    struct Milestone {
        uint256 id;            // Unique milestone id (incremental, global counter)
        string description;    // Short description of the work for this milestone
        uint256 amount;        // ETH value (in wei) locked for this milestone
        bool isCompleted;      // true once the freelancer marks it done & it is accepted
        bool isClaimed;        // true once the payment for this milestone is released
        bool isDisputed;       // true if this milestone is part of an active dispute
        uint256 claimedAt;     // block.timestamp when payment was released
    }

    /// @notice Holds all the data for a single project.
    struct Project {
        uint256 id;                    // Unique project id (incremental counter)
        address client;                // The buyer who created the project
        address freelancer;            // The seller assigned after proposal approval (0x0 until then)
        ProjectType projectType;       // FixClaim or Milestones
        ProjectStatus status;          // Current lifecycle status
        uint256 fixClaimAmount;        // For FixClaim projects: the escrowed total
        uint256[] milestoneIds;        // Ordered list of milestone ids (sequential)
        uint256 totalFunded;           // Total ETH currently held in escrow for this project
        uint256 deadline;              // block.timestamp before which the project should be delivered
        uint256 reviewWindow;          // Seconds allowed for client review before auto-release
        uint256 lastReviewAt;          // Last time a review (approve/change) happened
        uint256 changesCount;          // How many times "changes required" was requested
        bool isSubmitted;              // true when freelancer has submitted work for review
        bool isDeliverableAccepted;    // true when client approved "no changes required"
        bool isProjectFunded;          // true once first escrow deposit happens
        string metadataHash;           // Optional off-chain pointer (IPFS/CID) for project details
    }

    /// @notice Counter for generating unique project ids (starts at 1).
    uint256 public projectCounter;

    /// @notice Counter for generating unique milestone ids (starts at 1).
    uint256 public milestoneCounter;

    /// @notice projectId => Project  (mapping of all projects).
    mapping(uint256 => Project) public projects;

    /// @notice milestoneId => Milestone (mapping of all milestones).
    mapping(uint256 => Milestone) public milestones;

    /// @notice projectId => milestoneId => whether that milestone belongs to this project.
    mapping(uint256 => mapping(uint256 => bool)) public projectMilestones;

    /// @notice Default review window (in seconds). 15 days = 15 * 24 * 60 * 60.
    uint256 public constant DEFAULT_REVIEW_WINDOW = 15 days;

    /// @notice Platform fee in basis points (e.g. 200 = 2%). 0 for now.
    uint256 public platformFeeBps;

    /// @notice Treasury address that receives platform fees.
    address public treasury;

    // =========================================================================
    //  EVENTS
    // =========================================================================
    //  Events let the frontend/backend listen to state changes on-chain.

    /// @notice Emitted when a project is created.
    event ProjectCreated(uint256 indexed projectId, address indexed client, ProjectType projectType);

    /// @notice Emitted when a freelancer is assigned after proposal approval.
    event ProjectApproved(uint256 indexed projectId, address indexed freelancer);

    /// @notice Emitted when ETH is deposited into escrow for a project.
    event FundsDeposited(uint256 indexed projectId, address indexed client, uint256 amount);

    /// @notice Emitted when a milestone is created by the freelancer.
    event MilestoneCreated(uint256 indexed projectId, uint256 indexed milestoneId, uint256 amount);

    /// @notice Emitted when the freelancer marks a milestone as complete.
    event MilestoneCompleted(uint256 indexed projectId, uint256 indexed milestoneId);

    /// @notice Emitted when a milestone payment is released to the freelancer.
    event MilestoneClaimed(uint256 indexed projectId, uint256 indexed milestoneId, address indexed freelancer, uint256 amount);

    /// @notice Emitted when the client approves "no changes required".
    event DeliverableApproved(uint256 indexed projectId);

    /// @notice Emitted when the client requests changes.
    event ChangesRequested(uint256 indexed projectId, uint256 newDeadline);

    /// @notice Emitted when the deadline is extended.
    event DeadlineExtended(uint256 indexed projectId, uint256 newDeadline);

    /// @notice Emitted when escrowed funds are refunded to the client.
    event FundsRefunded(uint256 indexed projectId, address indexed client, uint256 amount);

    /// @notice Emitted when the admin opens/closes a dispute.
    event DisputeOpened(uint256 indexed projectId);
    event DisputeResolved(uint256 indexed projectId);

    // =========================================================================
    //  MODIFIERS
    // =========================================================================

    /// @dev Ensures the caller is the client (buyer) of the given project.
    modifier onlyClient(uint256 _projectId) {
        require(msg.sender == projects[_projectId].client, "Blockefy: caller is not the client");
        _;
    }

    /// @dev Ensures the caller is the freelancer (seller) of the given project.
    modifier onlyFreelancer(uint256 _projectId) {
        require(msg.sender == projects[_projectId].freelancer, "Blockefy: caller is not the freelancer");
        _;
    }

    /// @dev Ensures the project exists (was created).
    modifier projectExists(uint256 _projectId) {
        require(_projectId > 0 && _projectId <= projectCounter, "Blockefy: project does not exist");
        _;
    }

    /// @dev Ensures the project is NOT in a disputed state (so normal operations are paused).
    modifier notDisputed(uint256 _projectId) {
        require(projects[_projectId].status != ProjectStatus.Disputed, "Blockefy: project is under dispute");
        _;
    }

    // =========================================================================
    //  CONSTRUCTOR
    // =========================================================================

    /**
     * @notice Deploys the Blockefy contract.
     * @param _treasury The address that will receive platform fees (if enabled later).
     * @dev The deployer (msg.sender) automatically becomes the owner/ADMIN via Ownable.
     */
    constructor(address _treasury) Ownable(msg.sender) {
        // Validate the treasury address is not zero.
        require(_treasury != address(0), "Blockefy: invalid treasury");
        treasury = _treasury;
        // Platform fee starts at 0% (we can enable 2% later with setPlatformFee()).
        platformFeeBps = 0;
    }

    // =========================================================================
    //  ADMIN (OWNER) FUNCTIONS
    // =========================================================================
    //  The admin is ONLY used for dispute management and fee configuration.
    //  It cannot create/approve projects or release payments on its own.

    /**
     * @notice Configures the platform fee (in basis points) collected on each release.
     * @param _platformFeeBps Fee in basis points. 200 == 2%. Max 1000 (10%).
     * @dev Only callable by the owner (admin). Kept for future monetization.
     */
    function setPlatformFee(uint256 _platformFeeBps) external onlyOwner {
        // Sanity cap to avoid absurd fees.
        require(_platformFeeBps <= 1000, "Blockefy: fee too high");
        platformFeeBps = _platformFeeBps;
    }

    /**
     * @notice Updates the treasury address that receives platform fees.
     * @param _treasury New treasury address.
     * @dev Only callable by the owner (admin).
     */
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Blockefy: invalid treasury");
        treasury = _treasury;
    }

    /**
     * @notice Opens a dispute on a project (locks all payments until resolved).
     * @param _projectId The id of the disputed project.
     * @dev Only callable by the owner (admin). Used when client/freelancer conflict.
     */
    function openDispute(uint256 _projectId) external onlyOwner projectExists(_projectId) {
        Project storage project = projects[_projectId];
        // Cannot dispute a completed or already disputed project.
        require(project.status != ProjectStatus.Completed, "Blockefy: project already completed");
        require(project.status != ProjectStatus.Disputed, "Blockefy: project already disputed");
        // Lock the project for dispute handling.
        project.status = ProjectStatus.Disputed;
        emit DisputeOpened(_projectId);
    }

    /**
     * @notice Resolves a dispute, returning the project to a usable state.
     * @param _projectId The id of the disputed project.
     * @param _toFreelancer Whether to force-release the remaining escrow to the freelancer
     *        (true) or refund it to the client (false).
     * @dev Only callable by the owner (admin). This is the final say in a conflict.
     */
    function resolveDispute(uint256 _projectId, bool _toFreelancer)
        external
        onlyOwner
        projectExists(_projectId)
    {
        Project storage project = projects[_projectId];
        require(project.status == ProjectStatus.Disputed, "Blockefy: project is not disputed");

        uint256 escrow = project.totalFunded;

        // Reset funding before transferring to avoid reentrancy surprises.
        project.totalFunded = 0;

        // Depending on the ruling, send the escrow to the freelancer or back to the client.
        if (_toFreelancer) {
            (bool success, ) = payable(project.freelancer).call{ value: escrow }("");
            require(success, "Blockefy: payout failed");
        } else {
            (bool success, ) = payable(project.client).call{ value: escrow }("");
            require(success, "Blockefy: refund failed");
        }

        // Mark the project as completed after resolution.
        project.status = ProjectStatus.Completed;
        emit DisputeResolved(_projectId);
    }

    // =========================================================================
    //  PROJECT CREATION & PROPOSAL APPROVAL
    // =========================================================================

    /**
     * @notice Creates a new project on-chain.
     * @param _projectType Whether it is a FixClaim (0) or Milestones (1) project.
     * @param _metadataHash Optional off-chain pointer (IPFS CID) to project details.
     * @return The newly created project id.
     * @dev Called by the CLIENT. The freelancer is not yet assigned at this point.
     */
    function createProject(ProjectType _projectType, string calldata _metadataHash)
        external
        returns (uint256)
    {
        // Bump the global project counter to get a fresh unique id.
        uint256 newId = ++projectCounter;

        // Initialise the new project in the mapping.
        projects[newId] = Project({
            id: newId,
            client: msg.sender,
            freelancer: address(0),           // assigned later on proposal approval
            projectType: _projectType,
            status: ProjectStatus.Created,
            fixClaimAmount: 0,
            milestoneIds: new uint256[](0),
            totalFunded: 0,
            deadline: 0,
            reviewWindow: DEFAULT_REVIEW_WINDOW,
            lastReviewAt: 0,
            changesCount: 0,
            isSubmitted: false,
            isDeliverableAccepted: false,
            isProjectFunded: false,
            metadataHash: _metadataHash
        });

        emit ProjectCreated(newId, msg.sender, _projectType);
        return newId;
    }

    /**
     * @notice Assigns a freelancer to a project once the CLIENT approves the proposal.
     * @param _projectId The project id.
     * @param _freelancer The address of the freelancer whose proposal was accepted.
     * @dev Called by the CLIENT after reviewing the freelancer's proposal (off-chain).
     *      The freelancer can only be set once.
     */
    function approveProject(uint256 _projectId, address _freelancer)
        external
        projectExists(_projectId)
        onlyClient(_projectId)
    {
        Project storage project = projects[_projectId];
        // A freelancer can only be assigned once.
        require(project.freelancer == address(0), "Blockefy: project already has a freelancer");
        // Prevent assigning the client themselves.
        require(_freelancer != address(0) && _freelancer != msg.sender, "Blockefy: invalid freelancer");

        project.freelancer = _freelancer;

        emit ProjectApproved(_projectId, _freelancer);
    }

    // =========================================================================
    //  MILESTONE CREATION (FREELANCER)
    // =========================================================================

    /**
     * @notice Creates a milestone for a Milestones project.
     * @param _projectId The project id.
     * @param _description A short description of the milestone work.
     * @param _amount The ETH value (in wei) to be locked for this milestone.
     * @return The newly created milestone id.
     * @dev Called by the FREELANCER. Milestones must be created in order and only
     *      before any funding / after a project is approved. The freelancer can
     *      create as many milestones as they want.
     */
    function createMilestone(uint256 _projectId, string calldata _description, uint256 _amount)
        external
        projectExists(_projectId)
        onlyFreelancer(_projectId)
        notDisputed(_projectId)
        returns (uint256)
    {
        Project storage project = projects[_projectId];
        // Only milestone-based projects can have milestones.
        require(project.projectType == ProjectType.Milestones, "Blockefy: not a milestones project");
        // Milestones cannot be added once the project is completed or cancelled.
        require(project.status == ProjectStatus.Created || project.status == ProjectStatus.Funded,
            "Blockefy: project is not open for milestones");
        // Milestone amount must be positive.
        require(_amount > 0, "Blockefy: milestone amount must be > 0");

        // Generate a fresh unique milestone id.
        uint256 newMilestoneId = ++milestoneCounter;

        // Store the milestone in the global mapping.
        milestones[newMilestoneId] = Milestone({
            id: newMilestoneId,
            description: _description,
            amount: _amount,
            isCompleted: false,
            isClaimed: false,
            isDisputed: false,
            claimedAt: 0
        });

        // Register that this milestone belongs to the project and push it to the ordered list.
        projectMilestones[_projectId][newMilestoneId] = true;
        project.milestoneIds.push(newMilestoneId);

        emit MilestoneCreated(_projectId, newMilestoneId, _amount);
        return newMilestoneId;
    }

    // =========================================================================
    //  FUNDING / ESCROW DEPOSIT (CLIENT)
    // =========================================================================

    /**
     * @notice Deposits ETH into escrow for a project.
     * @param _projectId The project id.
     * @dev Called by the CLIENT (payable, so ETH is sent along). This is the first
     *      deposit that activates the project. For a FixClaim project the client
     *      deposits the full amount; for a Milestones project the client deposits
     *      the current/next milestone amount.
     */
    function depositFunds(uint256 _projectId)
        external
        payable
        projectExists(_projectId)
        onlyClient(_projectId)
        notDisputed(_projectId)
    {
        Project storage project = projects[_projectId];
        // A freelancer must be assigned before any money is deposited.
        require(project.freelancer != address(0), "Blockefy: no freelancer assigned");
        // Deposit must be positive.
        require(msg.value > 0, "Blockefy: deposit must be > 0");

        if (project.projectType == ProjectType.FixClaim) {
            // For a fix claim, the client deposits the full one-time amount once.
            require(!project.isProjectFunded, "Blockefy: fix claim already funded");
            // Set the total fix claim amount to the deposited value.
            project.fixClaimAmount = msg.value;
        }

        // Track total escrowed ETH for this project.
        project.totalFunded += msg.value;
        project.isProjectFunded = true;
        // A funded project is considered "InProgress".
        project.status = ProjectStatus.InProgress;

        emit FundsDeposited(_projectId, msg.sender, msg.value);
    }

    // =========================================================================
    //  FIX CLAIM (ONE-TIME PAYMENT RELEASE)
    // =========================================================================

    /**
     * @notice Releases the full one-time fix claim payment to the freelancer.
     * @param _projectId The project id.
     * @dev For FixClaim projects only. The freelancer submits their work, the
     *      client approves "no changes required" (or the review window lapses),
     *      then either the freelancer or the client calls this to release funds.
     */
    function fixClaim(uint256 _projectId)
        external
        projectExists(_projectId)
        notDisputed(_projectId)
    {
        Project storage project = projects[_projectId];
        // Only valid for fix claim projects.
        require(project.projectType == ProjectType.FixClaim, "Blockefy: not a fix claim project");
        // Only the client or freelancer can trigger this.
        require(msg.sender == project.client || msg.sender == project.freelancer,
            "Blockefy: unauthorized");
        // The project must be funded.
        require(project.isProjectFunded, "Blockefy: project not funded");
        // The deliverable must have been accepted OR the review window lapsed.
        require(project.isDeliverableAccepted || _reviewLapsed(project), "Blockefy: deliverable not approved");

        uint256 escrow = project.totalFunded;
        // Reset funding before transfer.
        project.totalFunded = 0;

        // Transfer the escrow to the freelancer (minus platform fee, currently 0).
        _payFreelancer(project, escrow);

        // Mark the project completed.
        project.status = ProjectStatus.Completed;
    }

    // =========================================================================
    //  MILESTONE COMPLETION & CLAIMING (SEQUENTIAL)
    // =========================================================================

    /**
     * @notice Freelancer marks a milestone as complete (work delivered).
     * @param _projectId The project id.
     * @param _milestoneId The milestone id to mark complete.
     * @dev Marks the milestone as submitted. The client then reviews it.
     */
    function completeMilestone(uint256 _projectId, uint256 _milestoneId)
        external
        projectExists(_projectId)
        onlyFreelancer(_projectId)
        notDisputed(_projectId)
    {
        Project storage project = projects[_projectId];
        _requireValidMilestone(project, _milestoneId);

        Milestone storage milestone = milestones[_milestoneId];
        // Cannot complete an already completed or claimed milestone.
        require(!milestone.isCompleted && !milestone.isClaimed, "Blockefy: milestone already done");

        // Mark the milestone complete.
        milestone.isCompleted = true;
        // Track that the freelancer has submitted work.
        project.isSubmitted = true;
        // Start the review window from this submission so the 15-day
        // auto-release timer begins counting immediately.
        project.lastReviewAt = block.timestamp;

        emit MilestoneCompleted(_projectId, _milestoneId);
    }

    /**
     * @notice Releases the payment for a milestone to the freelancer.
     * @param _projectId The project id.
     * @param _milestoneId The milestone id to claim.
     * @dev Milestones are released in STRICT SEQUENTIAL ORDER (1 -> 2 -> 3).
     *      A milestone can only be claimed if all previous milestones are claimed.
     *      This can be called once the milestone is completed AND (approved by the
     *      client OR the review window lapsed).
     */
    function claimMilestone(uint256 _projectId, uint256 _milestoneId)
        external
        projectExists(_projectId)
        notDisputed(_projectId)
    {
        Project storage project = projects[_projectId];
        _requireValidMilestone(project, _milestoneId);
        // Only client or freelancer can trigger the claim.
        require(msg.sender == project.client || msg.sender == project.freelancer,
            "Blockefy: unauthorized");

        Milestone storage milestone = milestones[_milestoneId];
        // Milestone must be completed and not yet claimed.
        require(milestone.isCompleted, "Blockefy: milestone not completed");
        require(!milestone.isClaimed, "Blockefy: milestone already claimed");

        // Enforce sequential claiming: previous milestones must all be claimed.
        _requirePreviousClaimed(project, _milestoneId);

        // Ensure the milestone is approved or the review window lapsed.
        require(project.isDeliverableAccepted || _reviewLapsed(project), "Blockefy: not approved yet");

        // Record the milestone as claimed.
        milestone.isClaimed = true;
        milestone.claimedAt = block.timestamp;

        // Decrease total escrow by this milestone's amount.
        require(project.totalFunded >= milestone.amount, "Blockefy: insufficient escrow");
        project.totalFunded -= milestone.amount;

        // Pay the freelancer (minus platform fee, currently 0).
        _payFreelancer(project, milestone.amount);

        emit MilestoneClaimed(_projectId, _milestoneId, project.freelancer, milestone.amount);

        // If this was the last milestone, the project is completed.
        if (_isLastMilestone(project, _milestoneId)) {
            project.status = ProjectStatus.Completed;
        }
    }

    // =========================================================================
    //  CLIENT REVIEW FUNCTIONS
    // =========================================================================

    /**
     * @notice Client approves the delivered work ("no changes required").
     * @param _projectId The project id.
     * @dev Sets isDeliverableAccepted = true, which unlocks payment release. It also
     *      resets the review timer.
     */
    function approveDeliverable(uint256 _projectId)
        external
        projectExists(_projectId)
        onlyClient(_projectId)
        notDisputed(_projectId)
    {
        Project storage project = projects[_projectId];
        // Must have work submitted for review.
        require(project.isSubmitted, "Blockefy: no submission to approve");

        project.isDeliverableAccepted = true;
        project.lastReviewAt = block.timestamp;

        emit DeliverableApproved(_projectId);
    }

    /**
     * @notice Client requests changes on the delivered work.
     * @param _projectId The project id.
     * @param _extraDays Number of days to add to the deadline for revisions.
     * @dev Extends the project deadline and resets the review timer so the freelancer
     *      gets time to fix the deliverable.
     */
    function requestChanges(uint256 _projectId, uint256 _extraDays)
        external
        projectExists(_projectId)
        onlyClient(_projectId)
        notDisputed(_projectId)
    {
        Project storage project = projects[_projectId];
        // Must have work submitted for review.
        require(project.isSubmitted, "Blockefy: no submission to review");
        // At least one day must be added.
        require(_extraDays > 0, "Blockefy: extra days must be > 0");

        // Extend the deadline.
        project.deadline = block.timestamp + (_extraDays * 1 days);
        project.lastReviewAt = block.timestamp;
        project.changesCount += 1;

        emit ChangesRequested(_projectId, project.deadline);
    }

    /**
     * @notice Client extends the project deadline.
     * @param _projectId The project id.
     * @param _extraDays Number of days to extend.
     * @dev Useful if the deadline passes but the client wants to continue the work.
     */
    function extendDeadline(uint256 _projectId, uint256 _extraDays)
        external
        projectExists(_projectId)
        onlyClient(_projectId)
        notDisputed(_projectId)
    {
        require(_extraDays > 0, "Blockefy: extra days must be > 0");
        Project storage project = projects[_projectId];
        project.deadline = block.timestamp + (_extraDays * 1 days);

        emit DeadlineExtended(_projectId, project.deadline);
    }

    /**
     * @notice Client retrieves (refunds) their escrowed funds when the deadline has passed.
     * @param _projectId The project id.
     * @dev Only allowed if the project deadline has passed AND there is escrow to refund.
     *      Returns the entire escrowed amount to the client and cancels the project.
     */
    function retrieveFunds(uint256 _projectId)
        external
        projectExists(_projectId)
        onlyClient(_projectId)
        notDisputed(_projectId)
    {
        Project storage project = projects[_projectId];
        // Deadline must have passed.
        require(project.deadline != 0 && block.timestamp > project.deadline,
            "Blockefy: deadline not passed");
        // Must have escrow to refund.
        require(project.totalFunded > 0, "Blockefy: nothing to refund");

        uint256 refund = project.totalFunded;
        project.totalFunded = 0;
        project.status = ProjectStatus.Cancelled;

        // Send the full escrow back to the client.
        (bool success, ) = payable(msg.sender).call{ value: refund }("");
        require(success, "Blockefy: refund failed");

        emit FundsRefunded(_projectId, msg.sender, refund);
    }

    // =========================================================================
    //  VIEW / QUERY FUNCTIONS
    // =========================================================================

    /**
     * @notice Returns all milestone ids belonging to a project.
     * @param _projectId The project id.
     * @return The ordered array of milestone ids.
     */
    function getProjectMilestones(uint256 _projectId) external view projectExists(_projectId) returns (uint256[] memory) {
        return projects[_projectId].milestoneIds;
    }

    /**
     * @notice Returns the full list of milestones (as structs) for a project.
     * @param _projectId The project id.
     * @return milestonesOut An array of Milestone structs.
     */
    function getMilestonesDetails(uint256 _projectId)
        external
        view
        projectExists(_projectId)
        returns (Milestone[] memory milestonesOut)
    {
        uint256[] memory ids = projects[_projectId].milestoneIds;
        milestonesOut = new Milestone[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            milestonesOut[i] = milestones[ids[i]];
        }
    }

    /**
     * @notice Returns the escrow balance available in the contract for a project.
     * @param _projectId The project id.
     * @return The total funded but not yet released amount.
     */
    function getProjectEscrow(uint256 _projectId) external view projectExists(_projectId) returns (uint256) {
        return projects[_projectId].totalFunded;
    }

    /**
     * @notice Checks whether the review window for a project has lapsed.
     * @param _projectId The project id.
     * @return True if the client has not reviewed within the window.
     * @dev Only meaningful after the freelancer has submitted work (isSubmitted).
     */
    function isReviewLapsed(uint256 _projectId) external view projectExists(_projectId) returns (bool) {
        return _reviewLapsed(projects[_projectId]);
    }

    // =========================================================================
    //  INTERNAL / PRIVATE HELPER FUNCTIONS
    // =========================================================================

    /**
     * @dev Validates that a milestone belongs to the given project and is not disputed.
     * @param _project The project storage reference.
     * @param _milestoneId The milestone id to validate.
     */
    function _requireValidMilestone(Project storage _project, uint256 _milestoneId) private view {
        require(projectMilestones[_project.id][_milestoneId], "Blockefy: milestone not in project");
        require(!milestones[_milestoneId].isDisputed, "Blockefy: milestone disputed");
    }

    /**
     * @dev Enforces sequential milestone claiming: all milestones before this one
     *      must have been claimed already.
     * @param _project The project storage reference.
     * @param _milestoneId The milestone id being claimed.
     */
    function _requirePreviousClaimed(Project storage _project, uint256 _milestoneId) private view {
        uint256[] memory ids = _project.milestoneIds;
        // Iterate through the ordered list up to the current milestone.
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] == _milestoneId) {
                // Reached the target milestone; all before it are guaranteed claimed.
                return;
            }
            // Every milestone before the target must be claimed.
            require(milestones[ids[i]].isClaimed, "Blockefy: previous milestone not claimed");
        }
        // The target milestone was not found in the list (should not happen).
        revert("Blockefy: milestone not found");
    }

    /**
     * @dev Checks whether the given milestone is the last one in the project.
     * @param _project The project storage reference.
     * @param _milestoneId The milestone id to check.
     * @return True if it is the last milestone.
     */
    function _isLastMilestone(Project storage _project, uint256 _milestoneId) private view returns (bool) {
        uint256[] memory ids = _project.milestoneIds;
        return ids.length > 0 && ids[ids.length - 1] == _milestoneId;
    }

    /**
     * @dev Checks whether the client's review window has lapsed after a submission.
     * @param _project The project storage reference.
     * @return True if the freelancer submitted work and the client did not review
     *         within `reviewWindow` seconds (auto-release scenario).
     */
    function _reviewLapsed(Project storage _project) private view returns (bool) {
        // The auto-release only applies after the freelancer has submitted work.
        if (!_project.isSubmitted) {
            return false;
        }
        // Compare last review time + review window against now.
        return _project.lastReviewAt != 0 &&
               (block.timestamp > _project.lastReviewAt + _project.reviewWindow);
    }

    /**
     * @dev Pays the freelancer, subtracting the platform fee (currently 0%) if any.
     * @param _project The project storage reference.
     * @param _amount The gross amount to release.
     */
    function _payFreelancer(Project storage _project, uint256 _amount) private {
        // Compute the fee (basis points). Default 0, can be 2% later.
        uint256 fee = (_amount * platformFeeBps) / 10000;
        // Net amount the freelancer actually receives.
        uint256 net = _amount - fee;

        // Send the net amount to the freelancer.
        (bool success, ) = payable(_project.freelancer).call{ value: net }("");
        require(success, "Blockefy: payout failed");

        // If there is a fee, send it to the treasury.
        if (fee > 0) {
            (bool ok, ) = payable(treasury).call{ value: fee }("");
            require(ok, "Blockefy: treasury transfer failed");
        }
    }

    /**
     * @notice Allows the contract to receive ETH directly (e.g. accidental transfers).
     * @dev Required for a payable contract; otherwise direct ETH transfers revert.
     */
    receive() external payable {}
}
